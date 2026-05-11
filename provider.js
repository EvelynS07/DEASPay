// src/routes/accounts.js
import { Router } from 'express';
import { body, query as queryParam, validationResult } from 'express-validator';
import { query, withTransaction } from '../database/connection.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

// ── GET /accounts — lista contas do usuário ───────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, account_number, agency, account_type,
              balance, blocked_balance, credit_limit, credit_used,
              pix_key_cpf, pix_key_phone, pix_key_email, pix_key_random,
              external_bank_name, is_external, is_active, created_at
       FROM accounts
       WHERE user_id = $1 AND is_active = true
       ORDER BY is_external ASC, created_at ASC`,
      [req.user.id]
    );

    // Calcula crédito disponível
    const enriched = rows.map(acc => ({
      ...acc,
      credit_available: Math.max(0, acc.credit_limit - acc.credit_used),
      balance_available: acc.balance - acc.blocked_balance,
    }));

    return res.json(enriched);
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao buscar contas' });
  }
});

// ── GET /accounts/:id/balance — saldo em tempo real ──────────
router.get('/:id/balance', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT balance, blocked_balance, credit_limit, credit_used,
              (balance - blocked_balance) AS available,
              (credit_limit - credit_used) AS credit_available
       FROM accounts WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Conta não encontrada' });
    return res.json(rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao buscar saldo' });
  }
});

// ── GET /accounts/:id/transactions — extrato ─────────────────
router.get('/:id/transactions', [
  queryParam('page').optional().isInt({ min: 1 }).toInt(),
  queryParam('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  queryParam('type').optional().isIn(['credit','debit','pix','ted','boleto']),
  queryParam('start_date').optional().isISO8601(),
  queryParam('end_date').optional().isISO8601(),
  queryParam('category').optional().trim(),
], async (req, res) => {
  try {
    // Verifica propriedade da conta
    const accCheck = await query(
      `SELECT id FROM accounts WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!accCheck.rows[0]) return res.status(404).json({ error: 'Conta não encontrada' });

    const page = req.query.page || 1;
    const limit = req.query.limit || 20;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE account_id = $1';
    const params = [req.params.id];
    let paramIdx = 2;

    if (req.query.type) {
      whereClause += ` AND direction = $${paramIdx++}`;
      params.push(req.query.type);
    }
    if (req.query.category) {
      whereClause += ` AND category = $${paramIdx++}`;
      params.push(req.query.category);
    }
    if (req.query.start_date) {
      whereClause += ` AND created_at >= $${paramIdx++}`;
      params.push(req.query.start_date);
    }
    if (req.query.end_date) {
      whereClause += ` AND created_at <= $${paramIdx++}`;
      params.push(req.query.end_date);
    }

    const [txRows, countRow] = await Promise.all([
      query(
        `SELECT id, type, direction, status, amount, balance_after,
                description, category, counterpart_name, counterpart_bank,
                pix_key, source_bank, processed_at, created_at
         FROM transactions ${whereClause}
         ORDER BY created_at DESC
         LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset]
      ),
      query(`SELECT COUNT(*) FROM transactions ${whereClause}`, params),
    ]);

    return res.json({
      data: txRows.rows,
      pagination: {
        page,
        limit,
        total: parseInt(countRow.rows[0].count),
        pages: Math.ceil(countRow.rows[0].count / limit),
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao buscar extrato' });
  }
});

// ── POST /accounts/:id/pix — transferência Pix ───────────────
router.post('/:id/pix', [
  body('amount').isFloat({ min: 0.01 }).withMessage('Valor inválido'),
  body('pix_key').notEmpty().withMessage('Chave Pix obrigatória'),
  body('description').optional().trim().isLength({ max: 100 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { amount, pix_key, description } = req.body;
  const accountId = req.params.id;

  try {
    await withTransaction(async (client) => {
      // Verifica saldo
      const { rows: [account] } = await client.query(
        `SELECT balance, blocked_balance FROM accounts
         WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [accountId, req.user.id]
      );

      if (!account) throw { status: 404, message: 'Conta não encontrada' };

      const available = account.balance - account.blocked_balance;
      if (available < amount) throw { status: 422, message: 'Saldo insuficiente' };

      // Débita
      await client.query(
        `UPDATE accounts SET balance = balance - $1 WHERE id = $2`,
        [amount, accountId]
      );

      // Registra transação
      const newBalance = account.balance - amount;
      const endToEndId = `E${Date.now()}${Math.random().toString(36).slice(2,8).toUpperCase()}`;

      await client.query(`
        INSERT INTO transactions (
          account_id, type, direction, status, amount,
          balance_after, description, category,
          pix_key, pix_end_to_end_id, processed_at
        ) VALUES ($1,'pix','debit','completed',$2,$3,$4,'transferencia',$5,$6,NOW())
      `, [accountId, amount, newBalance, description || 'Transferência Pix', pix_key, endToEndId]);

      return res.status(201).json({
        message: 'Pix enviado com sucesso',
        end_to_end_id: endToEndId,
        amount,
        new_balance: newBalance,
      });
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    return res.status(500).json({ error: 'Erro ao processar Pix' });
  }
});

export default router;
