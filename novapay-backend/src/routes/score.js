// src/services/scoreService.js
// ================================================================
// Motor de cálculo de score de crédito
// Modelo próprio NovaPay baseado no FICO Score adaptado para o
// contexto brasileiro, enriquecido com dados do Open Finance
// ================================================================

import { query, withTransaction } from '../database/connection.js';

// Pesos dos fatores (total = 1.0)
const WEIGHTS = {
  payment_history: 0.35,  // histórico de pagamentos
  credit_usage:    0.30,  // utilização do crédito
  credit_age:      0.15,  // tempo de relacionamento
  credit_mix:      0.10,  // diversidade de produtos
  new_inquiries:   0.10,  // novas consultas de crédito
};

// Faixa máxima de pontos por fator
const MAX_SCORE = 1000;

/**
 * Calcula e persiste o score de crédito do usuário.
 * Chamado automaticamente após pagamentos, novos débitos,
 * e sincronizações Open Finance.
 */
export async function calculateAndSaveScore(userId) {
  const [userRow, accountRows, debtRows, txRows, consentRows] = await Promise.all([
    query(`SELECT created_at FROM users WHERE id = $1`, [userId]),
    query(`SELECT balance, credit_limit, credit_used FROM accounts WHERE user_id = $1 AND is_external = false`, [userId]),
    query(`SELECT status, days_overdue FROM debts WHERE user_id = $1`, [userId]),
    query(`
      SELECT direction, status, created_at
      FROM transactions t
      JOIN accounts a ON t.account_id = a.id
      WHERE a.user_id = $1 AND t.created_at > NOW() - INTERVAL '24 months'
      ORDER BY t.created_at DESC
      LIMIT 200
    `, [userId]),
    query(`SELECT status FROM open_finance_consents WHERE user_id = $1`, [userId]),
  ]);

  // ── Fator 1: Histórico de pagamentos (35%) ──────────────────
  // Penaliza por dívidas vencidas e negativações
  let paymentScore = 1.0;
  const activeDebts = debtRows.rows.filter(d => ['overdue', 'pending'].includes(d.status));
  const blacklisted = debtRows.rows.filter(d => d.status === 'overdue' && d.days_overdue > 30);

  if (blacklisted.length > 0) paymentScore -= 0.35 * blacklisted.length;
  if (activeDebts.length > 0) paymentScore -= 0.15 * activeDebts.length;
  paymentScore = Math.max(0, Math.min(1, paymentScore));

  // ── Fator 2: Utilização do crédito (30%) ───────────────────
  // Ideal: abaixo de 30% do limite
  let usageScore = 1.0;
  const acc = accountRows.rows[0];
  if (acc && acc.credit_limit > 0) {
    const usageRatio = acc.credit_used / acc.credit_limit;
    if (usageRatio >= 0.9)      usageScore = 0.1;
    else if (usageRatio >= 0.7) usageScore = 0.35;
    else if (usageRatio >= 0.5) usageScore = 0.55;
    else if (usageRatio >= 0.3) usageScore = 0.75;
    else                        usageScore = 1.0;
  }

  // ── Fator 3: Tempo de relacionamento (15%) ─────────────────
  let ageScore = 0.0;
  if (userRow.rows[0]) {
    const monthsOld = (Date.now() - new Date(userRow.rows[0].created_at)) / (1000 * 60 * 60 * 24 * 30);
    if (monthsOld >= 60)      ageScore = 1.0;
    else if (monthsOld >= 36) ageScore = 0.85;
    else if (monthsOld >= 24) ageScore = 0.70;
    else if (monthsOld >= 12) ageScore = 0.50;
    else if (monthsOld >= 6)  ageScore = 0.30;
    else                      ageScore = 0.10;
  }

  // ── Fator 4: Mix de crédito (10%) ─────────────────────────
  // Bônus por ter tipos variados de transações
  const txTypes = new Set(txRows.rows.map(t => t.type));
  const mixScore = Math.min(1.0, txTypes.size * 0.2);

  // ── Fator 5: Novas consultas (10%) ─────────────────────────
  // Simplificado: muitas transações negativas recentes = risco
  const recentDebits = txRows.rows.filter(t =>
    t.direction === 'debit' &&
    new Date(t.created_at) > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  ).length;
  const inquiryScore = Math.max(0, 1.0 - recentDebits * 0.05);

  // ── Bônus Open Finance ──────────────────────────────────────
  const activeConsents = consentRows.rows.filter(c => c.status === 'active').length;
  const openFinanceBonus = activeConsents * 0.02; // +2% por banco conectado

  // ── Score final ─────────────────────────────────────────────
  const rawScore =
    paymentScore  * WEIGHTS.payment_history +
    usageScore    * WEIGHTS.credit_usage +
    ageScore      * WEIGHTS.credit_age +
    mixScore      * WEIGHTS.credit_mix +
    inquiryScore  * WEIGHTS.new_inquiries +
    openFinanceBonus;

  const finalScore = Math.round(Math.min(1, rawScore) * MAX_SCORE);

  // Persiste no histórico
  await query(`
    INSERT INTO credit_score_history (
      user_id, score, payment_history, credit_usage,
      credit_age, credit_mix, new_inquiries, open_finance_data
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
  `, [userId, finalScore, paymentScore, usageScore, ageScore, mixScore, inquiryScore, activeConsents > 0]);

  return {
    score: finalScore,
    factors: {
      payment_history: Math.round(paymentScore * 100),
      credit_usage:    Math.round(usageScore * 100),
      credit_age:      Math.round(ageScore * 100),
      credit_mix:      Math.round(mixScore * 100),
      new_inquiries:   Math.round(inquiryScore * 100),
    },
    classification: getClassification(finalScore),
    open_finance_bonus: Math.round(openFinanceBonus * MAX_SCORE),
  };
}

export function getClassification(score) {
  if (score >= 851) return { label: 'Excelente', color: '#2e7d5a', emoji: '🟢' };
  if (score >= 701) return { label: 'Bom',       color: '#4caf7d', emoji: '🟩' };
  if (score >= 501) return { label: 'Regular',   color: '#f2608a', emoji: '🟡' };
  if (score >= 301) return { label: 'Baixo',     color: '#f0a44a', emoji: '🟠' };
  return              { label: 'Muito Baixo',    color: '#e05c6e', emoji: '🔴' };
}

// src/routes/score.js
import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';

const scoreRouter = Router();
scoreRouter.use(authenticate);

// ── GET /score — score atual ──────────────────────────────────
scoreRouter.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT score, payment_history, credit_usage, credit_age,
              credit_mix, new_inquiries, open_finance_data, calculated_at
       FROM credit_score_history
       WHERE user_id = $1
       ORDER BY calculated_at DESC
       LIMIT 1`,
      [req.user.id]
    );

    if (!rows[0]) {
      // Calcula na hora se não existir
      const result = await calculateAndSaveScore(req.user.id);
      return res.json(result);
    }

    const s = rows[0];
    return res.json({
      score: s.score,
      factors: {
        payment_history: Math.round(s.payment_history * 100),
        credit_usage:    Math.round(s.credit_usage * 100),
        credit_age:      Math.round(s.credit_age * 100),
        credit_mix:      Math.round(s.credit_mix * 100),
        new_inquiries:   Math.round(s.new_inquiries * 100),
      },
      classification: getClassification(s.score),
      open_finance_data: s.open_finance_data,
      calculated_at: s.calculated_at,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao buscar score' });
  }
});

// ── GET /score/history — evolução histórica ───────────────────
scoreRouter.get('/history', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT score, calculated_at
       FROM credit_score_history
       WHERE user_id = $1
       ORDER BY calculated_at ASC
       LIMIT 24`,
      [req.user.id]
    );
    return res.json(rows);
  } catch {
    return res.status(500).json({ error: 'Erro ao buscar histórico' });
  }
});

// ── POST /score/recalculate — força novo cálculo ──────────────
scoreRouter.post('/recalculate', async (req, res) => {
  try {
    const result = await calculateAndSaveScore(req.user.id);
    return res.json({ message: 'Score recalculado', ...result });
  } catch {
    return res.status(500).json({ error: 'Erro ao recalcular score' });
  }
});

export { scoreRouter };
export default scoreRouter;
