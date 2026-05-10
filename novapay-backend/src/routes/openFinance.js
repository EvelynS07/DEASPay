// src/routes/openFinance.js
// ================================================================
// Open Finance BR — Resolução CMN 4.949/2021
// Simula o fluxo real de consentimento e coleta de dados
// Em produção, integrar com o Diretório de Participantes do Bacen
// ================================================================

import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { query, withTransaction } from '../database/connection.js';
import { authenticate } from '../middleware/auth.js';
import { calculateAndSaveScore } from './score.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();
router.use(authenticate);

// ── GET /open-finance/institutions — catálogo disponível ──────
router.get('/institutions', async (req, res) => {
  try {
    const { rows: institutions } = await query(
      `SELECT ofi.id, ofi.name, ofi.ispb, ofi.logo_emoji, ofi.category,
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
  } catch {
    return res.status(500).json({ error: 'Erro ao listar instituições' });
  }
});

// ── GET /open-finance/consents — consentimentos ativos ────────
router.get('/consents', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT ofc.id, ofc.consent_id, ofc.status, ofc.permissions,
              ofc.shared_balance, ofc.shared_limit, ofc.last_sync_at,
              ofc.expires_at, ofc.revoked_at, ofc.created_at,
              ofi.name AS institution_name,
              ofi.logo_emoji, ofi.ispb, ofi.category
       FROM open_finance_consents ofc
       JOIN open_finance_institutions ofi ON ofc.institution_id = ofi.id
       WHERE ofc.user_id = $1
       ORDER BY ofc.created_at DESC`,
      [req.user.id]
    );
    return res.json(rows);
  } catch {
    return res.status(500).json({ error: 'Erro ao buscar consentimentos' });
  }
});

// ── POST /open-finance/consent — autorizar compartilhamento ───
router.post('/consent', [
  body('institution_id').isUUID().withMessage('ID de instituição inválido'),
  body('permissions').isObject().withMessage('Permissões inválidas'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { institution_id, permissions } = req.body;

  try {
    const { rows: [inst] } = await query(
      `SELECT id, name FROM open_finance_institutions WHERE id = $1 AND is_active = true`,
      [institution_id]
    );
    if (!inst) return res.status(404).json({ error: 'Instituição não encontrada' });

    // Verifica se já existe consentimento
    const existing = await query(
      `SELECT id, status FROM open_finance_consents WHERE user_id=$1 AND institution_id=$2`,
      [req.user.id, institution_id]
    );

    const consentId = `urn:novapay:consent:${uuidv4()}`;

    if (existing.rows[0]) {
      // Reativa consentimento existente
      await query(
        `UPDATE open_finance_consents
         SET status='active', permissions=$1, consent_id=$2,
             expires_at=NOW() + INTERVAL '1 year',
             revoked_at=null, revocation_reason=null
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

    // Dispara sync em background
    syncInstitutionData(req.user.id, institution_id).catch(console.error);

    return res.status(201).json({
      message: `Consentimento com ${inst.name} autorizado com sucesso`,
      consent_id: consentId,
      expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao criar consentimento' });
  }
});

// ── DELETE /open-finance/consent/:id — revogar ───────────────
router.delete('/consent/:id', async (req, res) => {
  const { reason } = req.body;

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

    return res.json({ message: `Compartilhamento com ${consent.name} revogado` });
  } catch {
    return res.status(500).json({ error: 'Erro ao revogar consentimento' });
  }
});

// ── POST /open-finance/sync/:institutionId — força sincronização
router.post('/sync/:institutionId', async (req, res) => {
  try {
    const result = await syncInstitutionData(req.user.id, req.params.institutionId);
    return res.json({ message: 'Sincronização concluída', ...result });
  } catch (err) {
    return res.status(500).json({ error: 'Erro na sincronização: ' + err.message });
  }
});

// ── GET /open-finance/summary — visão consolidada ─────────────
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
  } catch {
    return res.status(500).json({ error: 'Erro ao buscar resumo' });
  }
});

// ================================================================
// SIMULAÇÃO DO SYNC COM INSTITUIÇÃO EXTERNA
// Em produção: chama a API real da instituição com o token OAuth2
// gerado durante o fluxo de consentimento do Open Finance Brasil
// ================================================================
async function syncInstitutionData(userId, institutionId) {
  // Simula delay de rede
  await new Promise(r => setTimeout(r, 300 + Math.random() * 700));

  // Gera dados mock realistas
  const mockBalance = parseFloat((Math.random() * 8000 + 500).toFixed(2));
  const mockLimit   = [5000, 8000, 12000, 15000, 0][Math.floor(Math.random() * 5)];

  await query(
    `UPDATE open_finance_consents
     SET shared_balance=$1, shared_limit=$2, last_sync_at=NOW(), sync_error=null
     WHERE user_id=$3 AND institution_id=$4 AND status='active'`,
    [mockBalance, mockLimit, userId, institutionId]
  );

  // Recalcula score com novos dados
  await calculateAndSaveScore(userId);

  return { synced: true, balance: mockBalance, limit: mockLimit, synced_at: new Date() };
}

export default router;
