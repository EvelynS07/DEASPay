// src/routes/openFinance.js
// ================================================================
// Open Finance — área do cliente DEASPay para consentimentos e sync
// Agora o DEASPay também consegue RECEBER dados reais do Deas Finance
// via OAuth, além de expor dados para outros bancos em provider.js.
// ================================================================

import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { randomUUID } from 'crypto';
import { query } from '../database/connection.js';
import { authenticate } from '../middleware/auth.js';
import { calculateAndSaveScore } from './score.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

function appBaseUrl(req) {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.FRONTEND_URL?.split(',')[0]?.trim() ||
    `${req.protocol}://${req.get('host')}`
  ).replace(/\/$/, '');
}

function callbackUrlForProvider(req, providerName = '') {
  const base = appBaseUrl(req);
  const p = String(providerName || '').toLowerCase();

  // Alguns projetos parceiros registram callbacks diferentes.
  // Para o Larabank, deixe configurável na Vercel e use a rota sem /api por padrão,
  // porque alguns OAuth providers redirecionam para a página inicial quando o callback
  // não bate exatamente com o cadastrado. As duas rotas funcionam no DEASPay.
  if (p === 'larabank') {
    return (
      process.env.LARABANK_REDIRECT_URI ||
      process.env.LARABANK_CALLBACK_URL ||
      `${base}/open-finance/callback`
    ).replace(/\/$/, '');
  }

  if (p === 'deasfinance') {
    return (
      process.env.DEASFINANCE_REDIRECT_URI ||
      process.env.DEASFINANCE_CALLBACK_URL ||
      `${base}/api/open-finance/callback`
    ).replace(/\/$/, '');
  }

  return `${base}/api/open-finance/callback`;
}

function asMoneyNumber(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function getProviderConfig(institution) {
  const base = (institution.api_base_url || '').replace(/\/$/, '');
  const isDeasFinance = institution.ispb === '88880001' || /deas finance/i.test(institution.name || '') || /deas-three/i.test(base);
  const isLarabank = institution.ispb === '99990001' || /larabank/i.test(institution.name || '') || /larabank/i.test(base);

  if (isDeasFinance) {
    return {
      provider: 'deasfinance',
      clientId: process.env.DEASFINANCE_CLIENT_ID || process.env.DEAS_CLIENT_ID || 'deas_client_001',
      clientSecret: process.env.DEASFINANCE_CLIENT_SECRET || process.env.DEAS_CLIENT_SECRET || 'deas_secret_k9x2m7p4n8q1r6t3w5y8',
      authUrl: process.env.DEASFINANCE_AUTH_URL || `${base || 'https://deas-three.vercel.app'}/api/oauth/authorize`,
      tokenUrl: process.env.DEASFINANCE_TOKEN_URL || `${base || 'https://deas-three.vercel.app'}/api/oauth/token`,
      accountsUrl: process.env.DEASFINANCE_ACCOUNTS_URL || `${base || 'https://deas-three.vercel.app'}/api/open-finance/provider/accounts`,
    };
  }

  if (isLarabank) {
    return {
      provider: 'larabank',
      clientId: process.env.LARABANK_CLIENT_ID || 'client_tgonmpn3',
      clientSecret: process.env.LARABANK_CLIENT_SECRET || '',
      authUrl: process.env.LARABANK_AUTH_URL || `${base || 'https://larabankdigital-82k2.vercel.app'}/api/oauth/authorize`,
      tokenUrl: process.env.LARABANK_TOKEN_URL || `${base || 'https://larabankdigital-82k2.vercel.app'}/api/oauth/token`,
      accountsUrl: process.env.LARABANK_ACCOUNTS_URL || `${base || 'https://larabankdigital-82k2.vercel.app'}/api/open-finance/provider/accounts`,
    };
  }

  return null;
}

function normalizeExternalPayload(raw) {
  const account = raw?.account || raw?.accounts?.[0] || raw?.data?.account || raw?.data?.accounts?.[0] || raw || {};
  const transactions = raw?.transactions || raw?.account?.transactions || raw?.data?.transactions || [];
  const debts = raw?.debts || raw?.account?.debts || raw?.data?.debts || [];

  const balance = asMoneyNumber(
    account.availableBalance ?? account.balanceAvailable ?? account.available_balance ??
    account.balance_available ?? account.saldoDisponivel ?? account.balance ?? account.saldo
  );

  const debt = asMoneyNumber(
    account.debt ?? account.totalDebt ?? account.total_debt ?? account.debtsTotal ??
    account.dividas ?? (Array.isArray(debts) ? debts.reduce((s, d) => s + asMoneyNumber(d.current_amount ?? d.currentAmount ?? d.amount ?? d.valor), 0) : 0)
  );

  const limit = asMoneyNumber(
    account.limit ?? account.creditLimit ?? account.credit_limit ?? account.limite ?? account.credit_available
  );

  const income = asMoneyNumber(
    account.estimatedIncome ?? account.estimated_income ?? account.monthlyIncome ?? account.monthly_income ?? account.rendaEstimada ?? account.renda
  );

  const score = Math.max(0, Math.min(1000, Math.round(asMoneyNumber(
    account.creditScore ?? account.score ?? account.externalScore ?? raw?.score ?? raw?.creditScore
  ))));

  return { balance, debt, limit, income, score, transactions, debts, raw };
}

async function ensureConsentExtraColumns() {
  await query(`ALTER TABLE open_finance_consents ADD COLUMN IF NOT EXISTS shared_debt DECIMAL(15,2) DEFAULT 0`);
  await query(`ALTER TABLE open_finance_consents ADD COLUMN IF NOT EXISTS shared_income DECIMAL(15,2) DEFAULT 0`);
  await query(`ALTER TABLE open_finance_consents ADD COLUMN IF NOT EXISTS shared_score SMALLINT DEFAULT 0`);
  await query(`ALTER TABLE open_finance_consents ADD COLUMN IF NOT EXISTS provider_access_token TEXT`);
  await query(`ALTER TABLE open_finance_consents ADD COLUMN IF NOT EXISTS provider_refresh_token TEXT`);
  await query(`ALTER TABLE open_finance_consents ADD COLUMN IF NOT EXISTS provider_payload JSONB DEFAULT '{}'`);
  await query(`ALTER TABLE open_finance_consents ADD COLUMN IF NOT EXISTS provider_state TEXT`);
}

router.get('/institutions', authenticate, async (req, res) => {
  try {
    await ensureConsentExtraColumns();
    const { rows: institutions } = await query(
      `SELECT ofi.id, ofi.name, ofi.ispb, ofi.logo_emoji, ofi.category, ofi.api_base_url,
              ofc.id AS consent_db_id,
              ofc.status AS consent_status,
              ofc.permissions,
              ofc.shared_balance,
              ofc.shared_limit,
              COALESCE(ofc.shared_debt, 0) AS shared_debt,
              COALESCE(ofc.shared_income, 0) AS shared_income,
              COALESCE(ofc.shared_score, 0) AS shared_score,
              ofc.last_sync_at,
              ofc.expires_at,
              ofc.sync_error
       FROM open_finance_institutions ofi
       LEFT JOIN open_finance_consents ofc
         ON ofi.id = ofc.institution_id AND ofc.user_id = $1 AND ofc.status <> 'revoked'
       WHERE ofi.is_active = true
       ORDER BY ofi.name`,
      [req.user.id]
    );
    return res.json(institutions);
  } catch (err) {
    console.error('Erro ao listar instituições:', err);
    return res.status(500).json({ error: 'Erro ao listar instituições' });
  }
});

router.get('/consents', authenticate, async (req, res) => {
  try {
    await ensureConsentExtraColumns();
    const { rows } = await query(
      `SELECT ofc.id, ofc.consent_id, ofc.status, ofc.permissions,
              ofc.shared_balance, ofc.shared_limit,
              COALESCE(ofc.shared_debt, 0) AS shared_debt,
              COALESCE(ofc.shared_income, 0) AS shared_income,
              COALESCE(ofc.shared_score, 0) AS shared_score,
              ofc.last_sync_at, ofc.expires_at, ofc.revoked_at, ofc.created_at,
              ofc.sync_error,
              ofi.name AS institution_name,
              ofi.logo_emoji, ofi.ispb, ofi.category, ofi.api_base_url
       FROM open_finance_consents ofc
       JOIN open_finance_institutions ofi ON ofc.institution_id = ofi.id
       WHERE ofc.user_id = $1
       ORDER BY ofc.created_at DESC`,
      [req.user.id]
    );
    return res.json(rows);
  } catch (err) {
    console.error('Erro ao buscar consentimentos:', err);
    return res.status(500).json({ error: 'Erro ao buscar consentimentos' });
  }
});

router.post('/consent', authenticate, [
  body('institution_id').isUUID().withMessage('ID de instituição inválido'),
  body('permissions').optional().isObject().withMessage('Permissões inválidas'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { institution_id } = req.body;
  const permissions = req.body.permissions || {
    accounts: true,
    balances: true,
    transactions: true,
    customers_personal: true,
    score: true,
    debts: true,
  };

  try {
    await ensureConsentExtraColumns();
    const { rows: [inst] } = await query(
      `SELECT id, name, ispb, api_base_url FROM open_finance_institutions WHERE id = $1 AND is_active = true`,
      [institution_id]
    );
    if (!inst) return res.status(404).json({ error: 'Instituição não encontrada' });

    const provider = getProviderConfig(inst);
    const consentId = `urn:deaspay:consent:${uuidv4()}`;
    const state = `${req.user.id}:${institution_id}:${randomUUID()}`;

    const existing = await query(
      `SELECT id FROM open_finance_consents WHERE user_id=$1 AND institution_id=$2`,
      [req.user.id, institution_id]
    );

    if (existing.rows[0]) {
      await query(
        `UPDATE open_finance_consents
         SET status='active', permissions=$1, consent_id=$2,
             provider_state=$3,
             expires_at=NOW() + INTERVAL '1 year',
             revoked_at=null, revocation_reason=null, sync_error=null
         WHERE id=$4`,
        [JSON.stringify(permissions), consentId, state, existing.rows[0].id]
      );
    } else {
      await query(
        `INSERT INTO open_finance_consents
         (user_id, institution_id, consent_id, status, permissions, expires_at, provider_state)
         VALUES ($1,$2,$3,'active',$4, NOW() + INTERVAL '1 year',$5)`,
        [req.user.id, institution_id, consentId, JSON.stringify(permissions), state]
      );
    }

    // Bancos com OAuth real: redireciona para o banco parceiro autorizar.
    if (provider?.authUrl && provider?.clientId) {
      const redirectUri = callbackUrlForProvider(req, provider.provider);
      const url = new URL(provider.authUrl);
      // Envia nos dois padrões porque o Larabank e outros projetos podem esperar
      // snake_case ou camelCase. Isso evita cair na página inicial por parâmetro ausente.
      url.searchParams.set('client_id', provider.clientId);
      url.searchParams.set('clientId', provider.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('redirectUri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('responseType', 'code');
      url.searchParams.set('scope', provider.provider === 'larabank' ? 'accounts balances transactions score debts' : 'accounts balances transactions score debts customers_personal');
      url.searchParams.set('state', state);
      return res.status(200).json({
        message: `Redirecionando para autorização no ${inst.name}`,
        redirect_url: url.toString(),
        requires_redirect: true,
      });
    }

    const syncResult = await syncInstitutionData(req.user.id, institution_id);

    return res.status(201).json({
      message: `Consentimento com ${inst.name} autorizado com sucesso`,
      consent_id: consentId,
      expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      sync: syncResult,
    });
  } catch (err) {
    console.error('Erro ao criar consentimento:', err);
    return res.status(500).json({ error: 'Erro ao criar consentimento: ' + err.message });
  }
});

router.get('/callback', async (req, res) => {
  try {
    await ensureConsentExtraColumns();
    const { code, state, error, error_description } = req.query;
    const base = appBaseUrl(req);

    if (error) {
      return res.redirect(`${base}/?openFinanceError=${encodeURIComponent(error_description || error)}`);
    }

    if (!code || !state) {
      return res.status(400).type('html').send('Callback Open Finance inválido: code e state são obrigatórios.');
    }

    const { rows: [consent] } = await query(
      `SELECT ofc.id, ofc.user_id, ofc.institution_id, ofi.name, ofi.ispb, ofi.api_base_url
       FROM open_finance_consents ofc
       JOIN open_finance_institutions ofi ON ofi.id = ofc.institution_id
       WHERE ofc.provider_state = $1 AND ofc.status = 'active'
       ORDER BY ofc.created_at DESC
       LIMIT 1`,
      [String(state)]
    );

    if (!consent) {
      return res.status(404).type('html').send('Consentimento não encontrado ou expirado. Volte ao DEASPay e peça a conexão novamente.');
    }

    const provider = getProviderConfig(consent);
    if (!provider) {
      return res.status(400).type('html').send('Provider não configurado para esta instituição.');
    }

    const redirectUri = callbackUrlForProvider(req, provider.provider);
    const tokenResp = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        code: String(code),
        redirect_uri: redirectUri,
      }),
    });

    const tokenJson = await tokenResp.json().catch(() => ({}));
    if (!tokenResp.ok || !tokenJson.access_token) {
      await query(`UPDATE open_finance_consents SET sync_error=$1 WHERE id=$2`, [JSON.stringify(tokenJson), consent.id]);
      return res.status(502).type('html').send(`Falha ao trocar code por token: ${JSON.stringify(tokenJson)}`);
    }

    await query(
      `UPDATE open_finance_consents
       SET provider_access_token=$1, provider_refresh_token=$2, sync_error=null, provider_state=null
       WHERE id=$3`,
      [tokenJson.access_token, tokenJson.refresh_token || null, consent.id]
    );

    await syncInstitutionData(consent.user_id, consent.institution_id, tokenJson.access_token);

    return res.redirect(`${base}/?openFinanceConnected=${encodeURIComponent(consent.name)}`);
  } catch (err) {
    console.error('Erro no callback Open Finance:', err);
    return res.status(500).type('html').send('Erro no callback Open Finance: ' + err.message);
  }
});

router.delete('/consent/:id', authenticate, async (req, res) => {
  const { reason } = req.body || {};

  try {
    const { rows: [consent] } = await query(
      `SELECT ofc.id, ofi.name FROM open_finance_consents ofc
       JOIN open_finance_institutions ofi ON ofc.institution_id = ofi.id
       WHERE ofc.id=$1 AND ofc.user_id=$2`,
      [req.params.id, req.user.id]
    );

    if (!consent) return res.status(404).json({ error: 'Consentimento não encontrado' });

    await query(
      `UPDATE open_finance_consents
       SET status='revoked', revoked_at=NOW(), revocation_reason=$1
       WHERE id=$2`,
      [reason || 'Revogado pelo usuário', req.params.id]
    );

    await calculateAndSaveScore(req.user.id);

    return res.json({ message: `Compartilhamento com ${consent.name} revogado` });
  } catch (err) {
    console.error('Erro ao revogar consentimento:', err);
    return res.status(500).json({ error: 'Erro ao revogar consentimento' });
  }
});

router.post('/sync/:institutionId', authenticate, async (req, res) => {
  try {
    const result = await syncInstitutionData(req.user.id, req.params.institutionId);
    return res.json({ message: 'Sincronização concluída', ...result });
  } catch (err) {
    console.error('Erro na sincronização:', err);
    return res.status(500).json({ error: 'Erro na sincronização: ' + err.message });
  }
});

router.get('/summary', authenticate, async (req, res) => {
  try {
    await ensureConsentExtraColumns();
    const { rows } = await query(
      `SELECT
         COUNT(*) FILTER (WHERE ofc.status='active') AS active_consents,
         COUNT(*) FILTER (WHERE ofc.status='revoked') AS revoked_consents,
         COALESCE(SUM(ofc.shared_balance) FILTER (WHERE ofc.status='active'), 0) AS total_shared_balance,
         COALESCE(SUM(ofc.shared_limit) FILTER (WHERE ofc.status='active'), 0) AS total_shared_limit,
         COALESCE(AVG(NULLIF(ofc.shared_score,0)) FILTER (WHERE ofc.status='active'), 0) AS avg_external_score,
         MAX(ofc.last_sync_at) AS last_sync_at
       FROM open_finance_consents ofc
       WHERE ofc.user_id = $1`,
      [req.user.id]
    );
    return res.json(rows[0]);
  } catch (err) {
    console.error('Erro ao buscar resumo:', err);
    return res.status(500).json({ error: 'Erro ao buscar resumo' });
  }
});

async function syncInstitutionData(userId, institutionId, accessTokenFromCallback = null) {
  await ensureConsentExtraColumns();
  const { rows: [institution] } = await query(
    `SELECT ofi.id, ofi.name, ofi.ispb, ofi.api_base_url, ofc.provider_access_token
     FROM open_finance_institutions ofi
     LEFT JOIN open_finance_consents ofc ON ofc.institution_id = ofi.id AND ofc.user_id = $1 AND ofc.status='active'
     WHERE ofi.id = $2`,
    [userId, institutionId]
  );

  if (!institution) throw new Error('Instituição não encontrada');

  const provider = getProviderConfig(institution);
  const accessToken = accessTokenFromCallback || institution.provider_access_token;

  // Se temos endpoint externo e token, busca dados REAIS do banco parceiro.
  if (provider?.accountsUrl && accessToken) {
    const resp = await fetch(provider.accountsUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const raw = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      await query(`UPDATE open_finance_consents SET sync_error=$1 WHERE user_id=$2 AND institution_id=$3`, [JSON.stringify(raw), userId, institutionId]);
      throw new Error(raw?.error || raw?.message || 'Banco parceiro recusou a sincronização');
    }

    const data = normalizeExternalPayload(raw);
    await query(
      `UPDATE open_finance_consents
       SET shared_balance=$1,
           shared_limit=$2,
           shared_debt=$3,
           shared_income=$4,
           shared_score=$5,
           provider_payload=$6,
           last_sync_at=NOW(),
           sync_error=null
       WHERE user_id=$7 AND institution_id=$8 AND status='active'`,
      [data.balance, data.limit, data.debt, data.income, data.score, JSON.stringify(raw), userId, institutionId]
    );

    await calculateAndSaveScore(userId);
    return { synced: true, source: institution.name, ...data, synced_at: new Date().toISOString() };
  }

  // Fallback local: evita dados ocultos quando ainda não houve autorização OAuth.
  const { rows: [accountTotals] } = await query(
    `SELECT COALESCE(SUM(balance - blocked_balance), 0) AS available_balance,
            COALESCE(SUM(credit_limit), 0) AS credit_limit
     FROM accounts
     WHERE user_id = $1 AND is_active = true`,
    [userId]
  );

  const balance = Number(accountTotals?.available_balance || 0);
  const limit = Number(accountTotals?.credit_limit || 0);

  await query(
    `UPDATE open_finance_consents
     SET shared_balance=$1, shared_limit=$2, last_sync_at=NOW(), sync_error=null
     WHERE user_id=$3 AND institution_id=$4 AND status='active'`,
    [balance, limit, userId, institutionId]
  );

  await calculateAndSaveScore(userId);

  return { synced: true, source: 'local', balance, limit, synced_at: new Date().toISOString() };
}

export default router;
