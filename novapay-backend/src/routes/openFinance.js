// src/routes/openFinance.js
// ================================================================
// Open Finance — área do cliente DEASPay para consentimentos e sync
// ================================================================

import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { query } from '../database/connection.js';
import { authenticate } from '../middleware/auth.js';
import { calculateAndSaveScore } from './score.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();
router.use(authenticate);

router.get('/institutions', async (req, res) => {
  try {
    const { rows: institutions } = await query(
      `SELECT ofi.id, ofi.name, ofi.ispb, ofi.logo_emoji, ofi.category, ofi.api_base_url,
              ofc.status AS consent_status,
              ofc.permissions,
              ofc.shared_balance,
              ofc.shared_limit,
              ofc.last_sync_at,
              ofc.expires_at
       FROM open_finance_institutions ofi
       LEFT JOIN open_finance_consents ofc
         ON ofi.id = ofc.institution_id AND ofc.user_id = $1
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

router.get('/consents', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT ofc.id, ofc.consent_id, ofc.status, ofc.permissions,
              ofc.shared_balance, ofc.shared_limit, ofc.last_sync_at,
              ofc.expires_at, ofc.revoked_at, ofc.created_at,
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

router.post('/consent', [
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
    const { rows: [inst] } = await query(
      `SELECT id, name FROM open_finance_institutions WHERE id = $1 AND is_active = true`,
      [institution_id]
    );
    if (!inst) return res.status(404).json({ error: 'Instituição não encontrada' });

    const existing = await query(
      `SELECT id FROM open_finance_consents WHERE user_id=$1 AND institution_id=$2`,
      [req.user.id, institution_id]
    );

    const consentId = `urn:deaspay:consent:${uuidv4()}`;

    if (existing.rows[0]) {
      await query(
        `UPDATE open_finance_consents
         SET status='active', permissions=$1, consent_id=$2,
             expires_at=NOW() + INTERVAL '1 year',
             revoked_at=null, revocation_reason=null, sync_error=null
         WHERE id=$3`,
        [JSON.stringify(permissions), consentId, existing.rows[0].id]
      );
    } else {
      await query(
        `INSERT INTO open_finance_consents
         (user_id, institution_id, consent_id, status, permissions, expires_at)
         VALUES ($1,$2,$3,'active',$4, NOW() + INTERVAL '1 year')`,
        [req.user.id, institution_id, consentId, JSON.stringify(permissions)]
      );
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
    return res.status(500).json({ error: 'Erro ao criar consentimento' });
  }
});

router.delete('/consent/:id', async (req, res) => {
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

router.post('/sync/:institutionId', async (req, res) => {
  try {
    const result = await syncInstitutionData(req.user.id, req.params.institutionId);
    return res.json({ message: 'Sincronização concluída', ...result });
  } catch (err) {
    return res.status(500).json({ error: 'Erro na sincronização: ' + err.message });
  }
});

router.get('/summary', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT
         COUNT(*) FILTER (WHERE ofc.status='active') AS active_consents,
         COUNT(*) FILTER (WHERE ofc.status='revoked') AS revoked_consents,
         COALESCE(SUM(ofc.shared_balance) FILTER (WHERE ofc.status='active'), 0) AS total_shared_balance,
         COALESCE(SUM(ofc.shared_limit) FILTER (WHERE ofc.status='active'), 0) AS total_shared_limit,
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

async function syncInstitutionData(userId, institutionId) {
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

  return { synced: true, balance, limit, synced_at: new Date().toISOString() };
}

export default router;
