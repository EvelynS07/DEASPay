// src/routes/debts.js
import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { query, withTransaction } from '../database/connection.js';
import { authenticate } from '../middleware/auth.js';
import { calculateAndSaveScore } from './score.js';

const router = Router();
router.use(authenticate);

// ── GET /debts — todas as dívidas do usuário ──────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, creditor_name, creditor_cnpj, contract_number,
              original_amount, current_amount, interest_rate,
              due_date, days_overdue, status,
              is_blacklisted, blacklisted_at, blacklisted_bureau,
              negotiated_amount, negotiated_at, paid_at,
              source, category, created_at,
              -- Recalcula juros em tempo real
              ROUND(original_amount * POWER(1 + interest_rate, GREATEST(days_overdue / 30.0, 0)), 2) AS amount_with_interest
       FROM debts
       WHERE user_id = $1
       ORDER BY
         CASE status
           WHEN 'overdue' THEN 1
           WHEN 'pending' THEN 2
           WHEN 'negotiating' THEN 3
           WHEN 'paid' THEN 4
           ELSE 5
         END,
         due_date ASC`,
      [req.user.id]
    );

    // Atualiza days_overdue automaticamente em background
    await query(
      `UPDATE debts
       SET days_overdue = GREATEST(0, EXTRACT(DAY FROM NOW() - due_date)::INTEGER)
       WHERE user_id = $1 AND status IN ('overdue','pending') AND due_date < NOW()`,
      [req.user.id]
    );

    const summary = {
      total_debt: rows.filter(d => ['overdue','pending','negotiating'].includes(d.status))
                      .reduce((s, d) => s + parseFloat(d.current_amount), 0),
      overdue_count: rows.filter(d => d.status === 'overdue').length,
      blacklisted_count: rows.filter(d => d.is_blacklisted).length,
    };

    return res.json({ debts: rows, summary });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao buscar inadimplências' });
  }
});

// ── GET /debts/:id — detalhe de uma dívida ────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM debts WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Dívida não encontrada' });
    return res.json(rows[0]);
  } catch {
    return res.status(500).json({ error: 'Erro ao buscar dívida' });
  }
});

// ── POST /debts/:id/negotiate — proposta de negociação ────────
router.post('/:id/negotiate', [
  body('offered_amount').isFloat({ min: 1 }).withMessage('Valor proposto inválido'),
  body('installments').optional().isInt({ min: 1, max: 60 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { offered_amount, installments = 1 } = req.body;

  try {
    const { rows: [debt] } = await query(
      `SELECT * FROM debts WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );

    if (!debt) return res.status(404).json({ error: 'Dívida não encontrada' });
    if (debt.status === 'paid') return res.status(409).json({ error: 'Dívida já quitada' });

    // Desconto automático: até 30% dependendo do tempo de atraso
    const discountRate = Math.min(0.30, debt.days_overdue * 0.003);
    const minAcceptable = debt.current_amount * (1 - discountRate);

    const accepted = offered_amount >= minAcceptable;

    if (accepted) {
      await query(
        `UPDATE debts
         SET status = 'negotiating',
             negotiated_amount = $1,
             negotiated_at = NOW()
         WHERE id = $2`,
        [offered_amount, debt.id]
      );
    }

    return res.json({
      accepted,
      offered_amount,
      original_amount: debt.original_amount,
      current_amount: debt.current_amount,
      min_acceptable: Math.round(minAcceptable * 100) / 100,
      discount_rate: Math.round(discountRate * 100),
      installments,
      installment_value: accepted ? offered_amount / installments : null,
      message: accepted
        ? 'Proposta aceita! Aguardando confirmação de pagamento.'
        : `Valor abaixo do mínimo aceitável. Tente R$ ${minAcceptable.toFixed(2)} ou mais.`,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao processar negociação' });
  }
});

// ── POST /debts/:id/pay — registra pagamento ─────────────────
router.post('/:id/pay', authenticate, async (req, res) => {
  const { account_id } = req.body;

  try {
    const { rows: [debt] } = await query(
      `SELECT * FROM debts WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!debt) return res.status(404).json({ error: 'Dívida não encontrada' });

    const payAmount = debt.negotiated_amount || debt.current_amount;

    await withTransaction(async (client) => {
      if (account_id) {
        const { rows: [acc] } = await client.query(
          `SELECT balance FROM accounts WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [account_id, req.user.id]
        );
        if (!acc || acc.balance < payAmount) {
          throw { status: 422, message: 'Saldo insuficiente' };
        }
        await client.query(
          `UPDATE accounts SET balance = balance - $1 WHERE id = $2`,
          [payAmount, account_id]
        );
        await client.query(`
          INSERT INTO transactions (account_id, type, direction, status, amount, description, category, processed_at)
          VALUES ($1, 'boleto', 'debit', 'completed', $2, $3, 'divida', NOW())
        `, [account_id, payAmount, `Pagamento — ${debt.creditor_name}`]);
      }

      await client.query(
        `UPDATE debts SET status='paid', paid_at=NOW(), is_blacklisted=false WHERE id=$1`,
        [debt.id]
      );
    });

    // Recalcula score após pagamento
    await calculateAndSaveScore(req.user.id);

    return res.json({
      message: 'Pagamento registrado com sucesso',
      paid_amount: payAmount,
      creditor: debt.creditor_name,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return res.status(500).json({ error: 'Erro ao processar pagamento' });
  }
});

export default router;
