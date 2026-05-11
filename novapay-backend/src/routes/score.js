// src/routes/score.js
// ================================================================
// Score de crédito real baseado em contas, transações, dívidas e OF
// ================================================================

import { Router } from 'express';
import { query } from '../database/connection.js';
import { authenticate } from '../middleware/auth.js';

const WEIGHTS = {
  payment_history: 0.35,
  credit_usage: 0.30,
  credit_age: 0.15,
  credit_mix: 0.10,
  new_inquiries: 0.10,
};
const MAX_SCORE = 1000;

export async function calculateAndSaveScore(userId) {
  const [userRow, accountRows, debtRows, txRows, consentRows] = await Promise.all([
    query(`SELECT created_at FROM users WHERE id = $1`, [userId]),
    query(`SELECT balance, credit_limit, credit_used FROM accounts WHERE user_id = $1 AND is_active = true`, [userId]),
    query(`SELECT status, days_overdue, is_blacklisted FROM debts WHERE user_id = $1`, [userId]),
    query(`
      SELECT t.type, t.direction, t.status, t.created_at
      FROM transactions t
      JOIN accounts a ON t.account_id = a.id
      WHERE a.user_id = $1 AND t.created_at > NOW() - INTERVAL '24 months'
      ORDER BY t.created_at DESC
      LIMIT 200
    `, [userId]),
    query(`SELECT status FROM open_finance_consents WHERE user_id = $1`, [userId]),
  ]);

  let paymentScore = 1.0;
  const activeDebts = debtRows.rows.filter((d) => ['overdue', 'pending', 'negotiating'].includes(d.status));
  const blacklisted = debtRows.rows.filter((d) => d.is_blacklisted || (d.status === 'overdue' && Number(d.days_overdue || 0) > 30));
  paymentScore -= blacklisted.length * 0.35;
  paymentScore -= activeDebts.length * 0.12;
  paymentScore = Math.max(0, Math.min(1, paymentScore));

  const totalLimit = accountRows.rows.reduce((sum, acc) => sum + Number(acc.credit_limit || 0), 0);
  const totalUsed = accountRows.rows.reduce((sum, acc) => sum + Number(acc.credit_used || 0), 0);
  let usageScore = 1.0;
  if (totalLimit > 0) {
    const usageRatio = totalUsed / totalLimit;
    if (usageRatio >= 0.9) usageScore = 0.1;
    else if (usageRatio >= 0.7) usageScore = 0.35;
    else if (usageRatio >= 0.5) usageScore = 0.55;
    else if (usageRatio >= 0.3) usageScore = 0.75;
  }

  let ageScore = 0.10;
  if (userRow.rows[0]) {
    const monthsOld = (Date.now() - new Date(userRow.rows[0].created_at).getTime()) / (1000 * 60 * 60 * 24 * 30);
    if (monthsOld >= 60) ageScore = 1.0;
    else if (monthsOld >= 36) ageScore = 0.85;
    else if (monthsOld >= 24) ageScore = 0.70;
    else if (monthsOld >= 12) ageScore = 0.50;
    else if (monthsOld >= 6) ageScore = 0.30;
  }

  const txTypes = new Set(txRows.rows.map((t) => t.type));
  const mixScore = Math.min(1.0, txTypes.size * 0.2);

  const recentDebits = txRows.rows.filter((t) =>
    t.direction === 'debit' &&
    new Date(t.created_at).getTime() > Date.now() - 30 * 24 * 60 * 60 * 1000
  ).length;
  const inquiryScore = Math.max(0, 1.0 - recentDebits * 0.05);

  const activeConsents = consentRows.rows.filter((c) => c.status === 'active').length;
  const openFinanceBonus = Math.min(0.10, activeConsents * 0.02);

  const rawScore =
    paymentScore * WEIGHTS.payment_history +
    usageScore * WEIGHTS.credit_usage +
    ageScore * WEIGHTS.credit_age +
    mixScore * WEIGHTS.credit_mix +
    inquiryScore * WEIGHTS.new_inquiries +
    openFinanceBonus;

  const finalScore = Math.round(Math.min(1, rawScore) * MAX_SCORE);

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
      credit_usage: Math.round(usageScore * 100),
      credit_age: Math.round(ageScore * 100),
      credit_mix: Math.round(mixScore * 100),
      new_inquiries: Math.round(inquiryScore * 100),
    },
    classification: getClassification(finalScore),
    open_finance_bonus: Math.round(openFinanceBonus * MAX_SCORE),
  };
}

export function getClassification(score) {
  if (score >= 851) return { label: 'Excelente', color: '#2e7d5a', emoji: '🟢' };
  if (score >= 701) return { label: 'Bom', color: '#4caf7d', emoji: '🟩' };
  if (score >= 501) return { label: 'Regular', color: '#f2608a', emoji: '🟡' };
  if (score >= 301) return { label: 'Baixo', color: '#f0a44a', emoji: '🟠' };
  return { label: 'Muito Baixo', color: '#e05c6e', emoji: '🔴' };
}

const scoreRouter = Router();
scoreRouter.use(authenticate);

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

    if (!rows[0]) return res.json(await calculateAndSaveScore(req.user.id));

    const s = rows[0];
    return res.json({
      score: s.score,
      factors: {
        payment_history: Math.round(Number(s.payment_history || 0) * 100),
        credit_usage: Math.round(Number(s.credit_usage || 0) * 100),
        credit_age: Math.round(Number(s.credit_age || 0) * 100),
        credit_mix: Math.round(Number(s.credit_mix || 0) * 100),
        new_inquiries: Math.round(Number(s.new_inquiries || 0) * 100),
      },
      classification: getClassification(s.score),
      open_finance_data: s.open_finance_data,
      calculated_at: s.calculated_at,
    });
  } catch (err) {
    console.error('Erro ao buscar score:', err);
    return res.status(500).json({ error: 'Erro ao buscar score' });
  }
});

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
  } catch (err) {
    console.error('Erro ao buscar histórico:', err);
    return res.status(500).json({ error: 'Erro ao buscar histórico' });
  }
});

scoreRouter.post('/recalculate', async (req, res) => {
  try {
    const result = await calculateAndSaveScore(req.user.id);
    return res.json({ message: 'Score recalculado', ...result });
  } catch (err) {
    console.error('Erro ao recalcular score:', err);
    return res.status(500).json({ error: 'Erro ao recalcular score' });
  }
});

export { scoreRouter };
export default scoreRouter;
