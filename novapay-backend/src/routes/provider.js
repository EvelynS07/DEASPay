// src/routes/provider.js
// ================================================================
// DEASPay como PROVEDOR Open Finance/OAuth2
// Endpoints públicos para outro banco iniciar conexão real:
//   GET  /authorize
//   POST /token
//   GET  /provider/accounts
// Também são montados aliases em /api/oauth/* para compatibilidade.
// ================================================================

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { query } from '../database/connection.js';
import { calculateAndSaveScore } from './score.js';

const router = Router();
const AUTH_CODE_TTL_MINUTES = 10;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '');
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  const [type, token] = header.split(' ');
  return type?.toLowerCase() === 'bearer' && token ? token : null;
}

async function getOptionalJwtUser(req) {
  const token = getBearerToken(req);
  if (!token) return null;

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.userId || decoded.id || decoded.sub;
    if (!userId) return null;

    const { rows } = await query(
      `SELECT id, full_name, cpf, email, phone
       FROM users
       WHERE id = $1 AND is_active = true`,
      [userId]
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

async function resolveUserForAuthorization(req) {
  const userFromJwt = await getOptionalJwtUser(req);
  if (userFromJwt) return userFromJwt;

  const userId = firstDefined(req.query.user_id, req.query.userId, req.query.sub);
  const cpf = firstDefined(req.query.cpf, req.query.document, req.query.document_number);
  const email = firstDefined(req.query.email, req.query.login_email);

  if (userId) {
    const { rows } = await query(
      `SELECT id, full_name, cpf, email, phone
       FROM users
       WHERE id = $1 AND is_active = true`,
      [userId]
    );
    return rows[0] || null;
  }

  if (cpf) {
    const { rows } = await query(
      `SELECT id, full_name, cpf, email, phone
       FROM users
       WHERE cpf = $1 AND is_active = true`,
      [cpf]
    );
    return rows[0] || null;
  }

  if (email) {
    const { rows } = await query(
      `SELECT id, full_name, cpf, email, phone
       FROM users
       WHERE lower(email) = lower($1) AND is_active = true`,
      [email]
    );
    return rows[0] || null;
  }

  return null;
}

function providerClientIsAllowed(clientId) {
  const allowedIds = [
    process.env.OAUTH_CLIENT_ID,
    process.env.PROVIDER_CLIENT_ID,
    process.env.OPEN_FINANCE_CLIENT_ID,
  ].filter(Boolean);

  return allowedIds.length === 0 || allowedIds.includes(clientId);
}

function providerSecretIsValid(clientSecret) {
  const allowedSecrets = [
    process.env.OAUTH_CLIENT_SECRET,
    process.env.PROVIDER_CLIENT_SECRET,
    process.env.OPEN_FINANCE_CLIENT_SECRET,
  ].filter(Boolean);

  return allowedSecrets.length === 0 || allowedSecrets.includes(clientSecret);
}

function buildRedirectUrl(redirectUri, params) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }
  return url.toString();
}

function oauthParam(req, ...names) {
  for (const name of names) {
    const queryValue = req.query?.[name];
    const bodyValue = req.body?.[name];
    const found = firstDefined(queryValue, bodyValue);
    if (found !== undefined) return found;
  }
  return undefined;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function collectOauthParams(req) {
  const merged = { ...(req.query || {}), ...(req.body || {}) };
  const keys = [
    'client_id', 'clientId', 'redirect_uri', 'redirectUri', 'response_type',
    'responseType', 'type', 'scope', 'state', 'code_challenge',
    'code_challenge_method', 'nonce'
  ];
  return keys
    .filter((key) => merged[key] !== undefined && merged[key] !== null && String(merged[key]).trim() !== '')
    .map((key) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(merged[key])}" />`)
    .join('\n      ');
}

function renderConsentForm(req, res, message = '') {
  // IMPORTANTE: action vazio + JS abaixo faz o navegador enviar o POST para a URL atual completa,
  // incluindo a query string original do Deas Finance (client_id, redirect_uri, state etc.).
  // Isso evita perder os parâmetros OAuth em rewrites da Vercel.
  const hiddenOauthFields = collectOauthParams(req);

  res.status(200).type('html').send(`<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DEASPay — Autorizar Open Finance</title>
  <style>
    body{font-family:Arial,sans-serif;background:#120912;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
    main{width:100%;max-width:440px;background:#1f1420;border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.35)}
    h1{margin:0 0 10px;font-size:24px} p{color:#d8cbd3;line-height:1.45} label{display:block;margin:18px 0 8px;color:#ff8caf;font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:.05em}
    input{width:100%;box-sizing:border-box;border:1px solid rgba(255,255,255,.18);border-radius:12px;background:#120912;color:#fff;padding:14px;font-size:16px}
    button{width:100%;border:0;border-radius:12px;background:linear-gradient(135deg,#c42d5a,#f2608a);color:#fff;font-weight:700;padding:14px;margin-top:18px;cursor:pointer}
    .msg{background:#3b1825;color:#ffd7e4;border:1px solid #9e3157;border-radius:12px;padding:10px;margin:14px 0}
    small{display:block;color:#a99aa2;margin-top:16px;line-height:1.4}
  </style>
</head>
<body>
  <main>
    <h1>Autorizar compartilhamento</h1>
    <p>Entre com sua conta DEASPay para liberar saldo, score, extrato e inadimplências para o banco solicitante. Se ainda não tem conta, cadastre-se primeiro no DEASPay.</p>
    ${message ? `<div class="msg">${message}</div>` : ''}
    <form id="authorize-form" method="POST" action="" onsubmit="this.action = window.location.href; const b=this.querySelector('button[type=submit]'); b.disabled=true; b.textContent='Autorizando...';">
      ${hiddenOauthFields}
      <label for="identifier">E-mail ou CPF</label>
      <input id="identifier" name="identifier" placeholder="seuemail@exemplo.com ou 000.000.000-00" required />
      <label for="password">Senha DEASPay</label>
      <input id="password" name="password" type="password" placeholder="••••••••" required />
      <button type="submit">Entrar, autorizar e continuar</button>
    </form>
    <small>O código gerado expira em ${AUTH_CODE_TTL_MINUTES} minutos e só pode ser trocado uma vez por token.</small>
  </main>
</body>
</html>`);
}

async function resolveUserFromIdentifier(identifier, password) {
  if (!identifier || !password) return null;
  const value = String(identifier).trim();
  const isEmail = value.includes('@');
  const { rows } = await query(
    isEmail
      ? `SELECT id, full_name, cpf, email, phone, password_hash FROM users WHERE lower(email) = lower($1) AND is_active = true`
      : `SELECT id, full_name, cpf, email, phone, password_hash FROM users WHERE cpf = $1 AND is_active = true`,
    [value]
  );
  const user = rows[0];
  if (!user) return null;
  const validPassword = await bcrypt.compare(password, user.password_hash);
  if (!validPassword) return null;
  delete user.password_hash;
  return user;
}

async function handleAuthorize(req, res) {
  const clientId = firstDefined(oauthParam(req, 'client_id', 'clientId'), process.env.OAUTH_CLIENT_ID);
  const redirectUri = oauthParam(req, 'redirect_uri', 'redirectUri');
  // Alguns clientes OAuth/Open Finance enviam responseType, tipo ou até omitem response_type.
  // Para compatibilidade com o Deas Finance, quando vier ausente assumimos Authorization Code.
  const rawResponseType = firstDefined(oauthParam(req, 'response_type', 'responseType', 'type'), 'code');
  const responseType = String(rawResponseType).toLowerCase().trim();
  const scope = firstDefined(oauthParam(req, 'scope'), 'accounts balances transactions score debts');
  const state = oauthParam(req, 'state');

  if (!['code', 'authorization_code'].includes(responseType)) {
    // Em vez de quebrar o fluxo com uma tela JSON crua, devolve erro OAuth para o redirect_uri quando possível.
    if (redirectUri) {
      try {
        return res.redirect(buildRedirectUrl(redirectUri, {
          error: 'unsupported_response_type',
          error_description: 'Use response_type=code.',
          state,
        }));
      } catch {}
    }
    return res.status(400).json({ error: 'unsupported_response_type', error_description: 'Use response_type=code.' });
  }
  if (!clientId || !redirectUri) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'client_id e redirect_uri são obrigatórios.',
      debug: {
        receivedQueryKeys: Object.keys(req.query || {}),
        receivedBodyKeys: Object.keys(req.body || {}),
      },
    });
  }
  if (!providerClientIsAllowed(clientId)) {
    return res.status(401).json({ error: 'unauthorized_client', error_description: 'client_id não autorizado neste provedor.' });
  }

  try {
    new URL(redirectUri);
  } catch {
    return res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri inválida.' });
  }

  try {
    const identifier = oauthParam(req, 'identifier');
    const password = oauthParam(req, 'password');
    const identifierUser = await resolveUserFromIdentifier(identifier, password);
    const user = identifierUser || await resolveUserForAuthorization(req);

    if (!user) {
      return renderConsentForm(req, res, identifier ? 'Usuário/senha inválidos ou conta inativa.' : '');
    }

    const code = `deaspay_code_${randomUUID()}`;
    await query(
      `INSERT INTO oauth_authorization_codes
       (code, user_id, client_id, redirect_uri, scope, expires_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' minutes')::interval)`,
      [code, user.id, clientId, redirectUri, scope, AUTH_CODE_TTL_MINUTES]
    );

    return res.redirect(buildRedirectUrl(redirectUri, { code, state }));
  } catch (err) {
    console.error('Erro em /authorize:', err);
    return res.status(500).json({ error: 'server_error', error_description: 'Erro ao iniciar autorização.' });
  }
}

// GET /authorize — início do fluxo OAuth2 Authorization Code.
router.get('/authorize', handleAuthorize);

// POST /authorize — envio do formulário de consentimento preservando client_id/redirect_uri.
router.post('/authorize', handleAuthorize);

// POST /token — troca authorization_code por access_token.
router.post('/token', async (req, res) => {
  // Compatibilidade: alguns clientes internos omitem grant_type. No fluxo de troca de code, assumimos authorization_code.
  const grantType = String(firstDefined(req.body.grant_type, req.body.grantType, 'authorization_code')).toLowerCase().trim();
  const code = req.body.code;
  const clientId = firstDefined(req.body.client_id, req.body.clientId);
  const clientSecret = firstDefined(req.body.client_secret, req.body.clientSecret);
  const redirectUri = firstDefined(req.body.redirect_uri, req.body.redirectUri);

  if (grantType !== 'authorization_code') {
    return res.status(400).json({ error: 'unsupported_grant_type', error_description: 'Use grant_type=authorization_code.' });
  }
  if (!code || !clientId) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'code e client_id são obrigatórios.' });
  }
  if (!providerClientIsAllowed(clientId) || !providerSecretIsValid(clientSecret)) {
    return res.status(401).json({ error: 'invalid_client', error_description: 'Credenciais OAuth inválidas.' });
  }

  try {
    const { rows } = await query(
      `SELECT id, user_id, client_id, redirect_uri, scope, expires_at, used_at
       FROM oauth_authorization_codes
       WHERE code = $1`,
      [code]
    );
    const authCode = rows[0];

    if (!authCode || authCode.used_at || new Date(authCode.expires_at).getTime() < Date.now()) {
      return res.status(401).json({ error: 'invalid_grant', error_description: 'Código inválido, expirado ou já utilizado.' });
    }
    if (authCode.client_id !== clientId) {
      return res.status(401).json({ error: 'invalid_grant', error_description: 'Código não pertence a este client_id.' });
    }
    if (redirectUri && authCode.redirect_uri !== redirectUri) {
      return res.status(401).json({ error: 'invalid_grant', error_description: 'redirect_uri diferente da autorização original.' });
    }

    const accessToken = `deaspay_token_${randomUUID()}`;

    await query(`UPDATE oauth_authorization_codes SET used_at = NOW() WHERE id = $1`, [authCode.id]);
    await query(
      `INSERT INTO oauth_access_tokens
       (token, user_id, client_id, scope, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + ($5 || ' seconds')::interval)`,
      [accessToken, authCode.user_id, clientId, authCode.scope, ACCESS_TOKEN_TTL_SECONDS]
    );

    return res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope: authCode.scope,
    });
  } catch (err) {
    console.error('Erro em /token:', err);
    return res.status(500).json({ error: 'server_error', error_description: 'Erro ao trocar código por token.' });
  }
});

async function authenticateProviderToken(req, res, next) {
  const token = getBearerToken(req) || req.query.access_token;
  if (!token) {
    return res.status(401).json({ error: 'invalid_token', error_description: 'Envie Authorization: Bearer <access_token>.' });
  }

  try {
    const { rows } = await query(
      `SELECT oat.id, oat.user_id, oat.client_id, oat.scope, oat.expires_at, oat.revoked_at,
              u.full_name, u.cpf, u.email, u.phone
       FROM oauth_access_tokens oat
       JOIN users u ON u.id = oat.user_id
       WHERE oat.token = $1 AND u.is_active = true`,
      [token]
    );
    const access = rows[0];

    if (!access || access.revoked_at || new Date(access.expires_at).getTime() < Date.now()) {
      return res.status(401).json({ error: 'invalid_token', error_description: 'Token inválido, expirado ou revogado.' });
    }

    req.providerAccess = access;
    return next();
  } catch (err) {
    console.error('Erro ao validar token provider:', err);
    return res.status(500).json({ error: 'server_error', error_description: 'Erro ao validar token.' });
  }
}

// GET /provider/accounts — dados reais do usuário autorizado.
router.get('/provider/accounts', authenticateProviderToken, async (req, res) => {
  const userId = req.providerAccess.user_id;

  try {
    const [accountsRows, debtsRows, txRows] = await Promise.all([
      query(
        `SELECT id, account_number, agency, account_type, balance, blocked_balance,
                credit_limit, credit_used, external_bank_name, is_external, created_at
         FROM accounts
         WHERE user_id = $1 AND is_active = true
         ORDER BY is_external ASC, created_at ASC`,
        [userId]
      ),
      query(
        `SELECT id, creditor_name, creditor_cnpj, contract_number, original_amount,
                current_amount, due_date, days_overdue, status, is_blacklisted,
                blacklisted_at, blacklisted_bureau, category, updated_at
         FROM debts
         WHERE user_id = $1
         ORDER BY due_date DESC`,
        [userId]
      ),
      query(
        `SELECT t.id, t.account_id, t.type, t.direction, t.status, t.amount,
                t.balance_after, t.description, t.category, t.counterpart_name,
                t.counterpart_bank, t.source_bank, t.processed_at, t.created_at
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE a.user_id = $1
         ORDER BY COALESCE(t.processed_at, t.created_at) DESC
         LIMIT 100`,
        [userId]
      ),
    ]);

    const score = await calculateAndSaveScore(userId);

    const accounts = accountsRows.rows.map((account) => {
      const balance = Number(account.balance || 0);
      const blocked = Number(account.blocked_balance || 0);
      const creditLimit = Number(account.credit_limit || 0);
      const creditUsed = Number(account.credit_used || 0);

      return {
        id: account.id,
        accountId: account.id,
        accountNumber: account.account_number,
        agency: account.agency,
        type: account.account_type,
        brandName: account.external_bank_name || 'DEASPay',
        currency: 'BRL',
        balance,
        blockedBalance: blocked,
        availableBalance: balance - blocked,
        creditLimit,
        creditUsed,
        creditAvailable: Math.max(0, creditLimit - creditUsed),
        isExternal: account.is_external,
      };
    });

    const debts = debtsRows.rows.map((debt) => ({
      id: debt.id,
      creditorName: debt.creditor_name,
      creditorCnpj: debt.creditor_cnpj,
      contractNumber: debt.contract_number,
      originalAmount: Number(debt.original_amount || 0),
      currentAmount: Number(debt.current_amount || 0),
      dueDate: debt.due_date,
      daysOverdue: debt.days_overdue,
      status: debt.status,
      isBlacklisted: debt.is_blacklisted,
      blacklistedAt: debt.blacklisted_at,
      blacklistedBureau: debt.blacklisted_bureau,
      category: debt.category,
      updatedAt: debt.updated_at,
    }));

    const transactions = txRows.rows.map((tx) => ({
      id: tx.id,
      accountId: tx.account_id,
      type: tx.type,
      direction: tx.direction,
      status: tx.status,
      amount: Number(tx.amount || 0),
      balanceAfter: tx.balance_after === null ? null : Number(tx.balance_after),
      description: tx.description,
      category: tx.category,
      counterpartName: tx.counterpart_name,
      counterpartBank: tx.counterpart_bank,
      sourceBank: tx.source_bank,
      processedAt: tx.processed_at,
      createdAt: tx.created_at,
    }));

    return res.json({
      ok: true,
      provider: 'DEASPay',
      client_id: req.providerAccess.client_id,
      user: {
        id: userId,
        name: req.providerAccess.full_name,
        cpf: req.providerAccess.cpf,
        email: req.providerAccess.email,
        phone: req.providerAccess.phone,
      },
      accounts,
      score,
      debts,
      inadimplencias: debts,
      transactions,
      summary: {
        totalAvailableBalance: accounts.reduce((sum, acc) => sum + acc.availableBalance, 0),
        totalCreditLimit: accounts.reduce((sum, acc) => sum + acc.creditLimit, 0),
        totalDebtAmount: debts
          .filter((debt) => debt.status !== 'paid')
          .reduce((sum, debt) => sum + debt.currentAmount, 0),
        blacklistedDebts: debts.filter((debt) => debt.isBlacklisted).length,
      },
    });
  } catch (err) {
    console.error('Erro em /provider/accounts:', err);
    return res.status(500).json({ error: 'server_error', error_description: 'Erro ao expor contas do usuário.' });
  }
});

export default router;
