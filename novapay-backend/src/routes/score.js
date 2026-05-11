// src/routes/score.js
// ================================================================
// Score DEASPay realista: calculado a partir de renda, uso de crédito,
// saldo, movimentação, inadimplência e dados Open Finance externos.
// Não usa score fixo/demo.
// ================================================================

import { Router } from 'express';
import { query } from '../database/connection.js';
import { authenticate } from '../middleware/auth.js';

const MAX_SCORE = 1000;

function clamp(value, min = 0, max = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function scoreFromIncome(income) {
  const value = money(income);
  if (value <= 0) return 0.35;
  if (value >= 15000) return 1.0;
  if (value >= 10000) return 0.9;
  if (value >= 7000) return 0.8;
  if (value >= 5000) return 0.7;
  if (value >= 3000) return 0.58;
  if (value >= 1500) return 0.45;
  return 0.35;
}

export async function ensureScoreSupportColumns() {
  await query(`ALTER TABLE open_finance_consents ADD COLUMN IF NOT EXISTS shared_score SMALLINT DEFAULT 0`).catch(() => {});
  await query(`ALTER TABLE open_finance_consents ADD COLUMN IF NOT EXISTS shared_debt DECIMAL(15,2) DEFAULT 0`).catch(() => {});
  await query(`ALTER TABLE open_finance_consents ADD COLUMN IF NOT EXISTS shared_income DECIMAL(15,2) DEFAULT 0`).catch(() => {});
  await query(`ALTER TABLE open_finance_consents ADD COLUMN IF NOT EXISTS provider_payload JSONB DEFAULT '{}'`).catch(() => {});
}

export async function calculateAndSaveScore(userId) {
  await ensureScoreSupportColumns();

  const [userRow, accountRows, debtRows, txRows, consentRows] = await Promise.all([
    query(`SELECT created_at, monthly_income, kyc_status, is_email_verified, is_phone_verified FROM users WHERE id = $1`, [userId]),
    query(`SELECT balance, blocked_balance, credit_limit, credit_used, created_at FROM accounts WHERE user_id = $1 AND is_active = true`, [userId]),
    query(`SELECT status, days_overdue, is_blacklisted, current_amount FROM debts WHERE user_id = $1`, [userId]),
    query(`
      SELECT t.type, t.direction, t.status, t.amount, t.created_at
      FROM transactions t
      JOIN accounts a ON t.account_id = a.id
      WHERE a.user_id = $1 AND t.created_at > NOW() - INTERVAL '12 months'
      ORDER BY t.created_at DESC
      LIMIT 300
    `, [userId]),
    query(`
      SELECT status, COALESCE(shared_score, 0) AS shared_score,
             COALESCE(shared_debt, 0) AS shared_debt,
             COALESCE(shared_income, 0) AS shared_income
      FROM open_finance_consents
      WHERE user_id = $1 AND status = 'active'
    `, [userId]),
  ]);

  const user = userRow.rows[0] || {};
  const accounts = accountRows.rows;
  const debts = debtRows.rows;
  const txs = txRows.rows.filter((t) => t.status === 'completed' || !t.status);
  const consents = consentRows.rows;

  const totalBalance = accounts.reduce((sum, acc) => sum + money(acc.balance) - money(acc.blocked_balance), 0);
  const totalLimit = accounts.reduce((sum, acc) => sum + money(acc.credit_limit), 0);
  const totalUsed = accounts.reduce((sum, acc) => sum + money(acc.credit_used), 0);
  const monthlyIncome = money(user.monthly_income) || money(consents.find((c) => money(c.shared_income) > 0)?.shared_income);

  const openDebts = debts.filter((d) => ['pending', 'overdue', 'negotiating'].includes(String(d.status || '').toLowerCase()));
  const overdueDebts = debts.filter((d) => String(d.status || '').toLowerCase() === 'overdue' || Number(d.days_overdue || 0) > 0);
  const blacklisted = debts.filter((d) => d.is_blacklisted || Number(d.days_overdue || 0) >= 30);
  const internalDebt = openDebts.reduce((sum, d) => sum + money(d.current_amount), 0);
  const externalDebt = consents.reduce((sum, c) => sum + money(c.shared_debt), 0);
  const totalDebt = internalDebt + externalDebt;

  // 1) Histórico de pagamento: principal fator. Dívidas e negativação derrubam forte.
  let paymentHistory = 1;
  paymentHistory -= overdueDebts.length * 0.18;
  paymentHistory -= blacklisted.length * 0.32;
  if (totalDebt > 0 && monthlyIncome > 0) paymentHistory -= clamp(totalDebt / Math.max(monthlyIncome * 4, 1), 0, 0.35);
  paymentHistory = clamp(paymentHistory);

  // 2) Uso de crédito: usar muito limite derruba, uso saudável melhora.
  let creditUsage = 0.62;
  if (totalLimit > 0) {
    const ratio = totalUsed / totalLimit;
    if (ratio <= 0.1) creditUsage = 0.95;
    else if (ratio <= 0.3) creditUsage = 0.88;
    else if (ratio <= 0.5) creditUsage = 0.72;
    else if (ratio <= 0.7) creditUsage = 0.52;
    else if (ratio <= 0.9) creditUsage = 0.32;
    else creditUsage = 0.14;
  }

  // 3) Capacidade financeira: renda declarada + colchão em conta.
  const incomeScore = scoreFromIncome(monthlyIncome);
  const reserveMonths = monthlyIncome > 0 ? totalBalance / monthlyIncome : 0;
  const reserveScore = clamp(reserveMonths / 3, 0.15, 1);
  const financialCapacity = clamp(incomeScore * 0.7 + reserveScore * 0.3);

  // 4) Idade/relacionamento bancário.
  const createdDates = [user.created_at, ...accounts.map((a) => a.created_at)].filter(Boolean).map((d) => new Date(d).getTime());
  const oldest = createdDates.length ? Math.min(...createdDates) : Date.now();
  const monthsOld = (Date.now() - oldest) / (1000 * 60 * 60 * 24 * 30);
  const creditAge = clamp(monthsOld / 48, 0.15, 1);

  // 5) Movimentação real: entradas, saídas, diversidade e conta verificada.
  const credits = txs.filter((t) => t.direction === 'credit');
  const debits = txs.filter((t) => t.direction === 'debit');
  const txTypes = new Set(txs.map((t) => t.type).filter(Boolean));
  const volumeCredit = credits.reduce((sum, t) => sum + money(t.amount), 0);
  const volumeDebit = debits.reduce((sum, t) => sum + money(t.amount), 0);
  const movementCountScore = clamp(txs.length / 60, 0.2, 1);
  const flowScore = volumeCredit > 0 ? clamp((volumeCredit - volumeDebit * 0.75) / Math.max(volumeCredit, 1), 0.25, 1) : 0.35;
  const mixScore = clamp(txTypes.size / 5, 0.2, 1);
  const verificationBonus = (user.kyc_status === 'approved' ? 0.04 : 0) + (user.is_email_verified ? 0.02 : 0) + (user.is_phone_verified ? 0.02 : 0);
  const bankingBehavior = clamp(movementCountScore * 0.35 + flowScore * 0.35 + mixScore * 0.22 + verificationBonus);

  // Score local ponderado.
  const localScore = Math.round(MAX_SCORE * clamp(
    paymentHistory * 0.35 +
    creditUsage * 0.22 +
    financialCapacity * 0.18 +
    creditAge * 0.10 +
    bankingBehavior * 0.15
  ));

  // Open Finance influencia de verdade: média ponderada dos scores externos ativos.
  const externalScores = consents
    .map((c) => Number(c.shared_score || 0))
    .filter((v) => Number.isFinite(v) && v > 0 && v <= 1000);
  const avgExternalScore = externalScores.length
    ? externalScores.reduce((sum, value) => sum + value, 0) / externalScores.length
    : 0;

  const finalScore = externalScores.length
    ? Math.round(localScore * 0.65 + avgExternalScore * 0.35)
    : localScore;

  await query(`
    INSERT INTO credit_score_history (
      user_id, score, payment_history, credit_usage,
      credit_age, credit_mix, new_inquiries, open_finance_data
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
  `, [
    userId,
    Math.max(0, Math.min(1000, finalScore)),
    paymentHistory,
    creditUsage,
    creditAge,
    bankingBehavior,
    financialCapacity,
    externalScores.length > 0,
  ]);

  return {
    score: Math.max(0, Math.min(1000, finalScore)),
    local_score: localScore,
    external_score_average: Math.round(avgExternalScore || 0),
    open_finance_data: externalScores.length > 0,
    indicators: {
      monthly_income: monthlyIncome,
      available_balance: totalBalance,
      credit_limit: totalLimit,
      credit_used: totalUsed,
      active_debt: totalDebt,
      transaction_count_12m: txs.length,
    },
    factors: {
      payment_history: Math.round(paymentHistory * 100),
      credit_usage: Math.round(creditUsage * 100),
      credit_age: Math.round(creditAge * 100),
      credit_mix: Math.round(bankingBehavior * 100),
      new_inquiries: Math.round(financialCapacity * 100),
    },
    classification: getClassification(finalScore),
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
    // Sempre recalcula ao abrir para refletir saldo, dívidas, extrato e Open Finance atuais.
    return res.json(await calculateAndSaveScore(req.user.id));
  } catch (err) {
    console.error('Erro ao buscar/recalcular score:', err);
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
