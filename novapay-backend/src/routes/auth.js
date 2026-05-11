// src/routes/auth.js
import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import bcrypt from 'bcryptjs';
import { query, withTransaction } from '../database/connection.js';
import { generateTokens, authenticate } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

// ── Validators ────────────────────────────────────────────────
const registerValidators = [
  body('full_name').trim().isLength({ min: 3, max: 200 }).withMessage('Nome inválido'),
  body('cpf').matches(/^\d{3}\.\d{3}\.\d{3}-\d{2}$/).withMessage('CPF inválido'),
  body('email').isEmail().normalizeEmail().withMessage('E-mail inválido'),
  body('phone').trim().isLength({ min: 10 }).withMessage('Telefone inválido'),
  body('password').isLength({ min: 8 })
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Senha fraca — use letras maiúsculas, minúsculas e números'),
  body('date_of_birth').isISO8601().withMessage('Data de nascimento inválida'),
  body('gender').isIn(['masculino','feminino','nao_binario','nao_informado']).withMessage('Gênero inválido'),
];

// ── POST /auth/register ───────────────────────────────────────
router.post('/register', registerValidators, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const {
    full_name, cpf, email, phone, password, date_of_birth, gender,
    zip_code, street, number, complement, neighborhood, city, state,
    monthly_income, occupation, employment_type,
  } = req.body;

  try {
    // Verifica duplicata
    const existing = await query(
      `SELECT id FROM users WHERE cpf = $1 OR email = $2`,
      [cpf, email]
    );
    if (existing.rows[0]) {
      return res.status(409).json({ error: 'CPF ou e-mail já cadastrado' });
    }

    const userId = uuidv4();
    const accountId = uuidv4();
    const passwordHash = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS) || 12);
    const declaredIncome = Number(monthly_income || 0);
    const initialCreditLimit = declaredIncome > 0
      ? Math.max(500, Math.min(25000, Math.round(declaredIncome * 1.2)))
      : 1500;

    await withTransaction(async (client) => {
      // Cria usuário
      await client.query(`
        INSERT INTO users (
          id, full_name, cpf, email, phone, password_hash,
          date_of_birth, gender, zip_code, street, number,
          complement, neighborhood, city, state,
          monthly_income, occupation, employment_type
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      `, [
        userId, full_name, cpf, email, phone, passwordHash,
        date_of_birth, gender, zip_code, street, number,
        complement, neighborhood, city, state,
        monthly_income || null, occupation || null, employment_type || null,
      ]);

      // Cria conta bancária automaticamente
      const accountNumber = String(Math.floor(Math.random() * 90000) + 10000) + '-' +
        String(Math.floor(Math.random() * 9) + 1);

      await client.query(`
        INSERT INTO accounts (
          id, user_id, account_number, account_type,
          balance, credit_limit, pix_key_cpf, pix_key_email
        ) VALUES ($1,$2,$3,'corrente',0.00,$4,$5,$6)
      `, [accountId, userId, accountNumber, initialCreditLimit, cpf, email]);

      // Score inicial zerado
      await client.query(`
        INSERT INTO credit_score_history (user_id, score, payment_history, credit_usage, credit_age, credit_mix, new_inquiries)
        VALUES ($1, 300, 0.5, 0.0, 0.0, 0.0, 1.0)
      `, [userId]);
    });

    const { access, refresh } = generateTokens(userId);

    return res.status(201).json({
      message: 'Conta criada com sucesso',
      token: access,
      refresh_token: refresh,
      user: { id: userId, full_name, email },
    });
  } catch (err) {
    console.error('Erro no registro:', err.message);
    return res.status(500).json({ error: 'Erro interno ao criar conta' });
  }
});

// ── POST /auth/login ──────────────────────────────────────────
router.post('/login', [
  body('email').trim().notEmpty().withMessage('Informe e-mail ou CPF'),
  body('password').notEmpty().withMessage('Informe a senha'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const login = String(req.body.email || '').trim();
  const { password } = req.body;

  try {
    const { rows } = await query(
      `SELECT id, full_name, email, password_hash, is_active, plan, kyc_status
       FROM users
       WHERE lower(email) = lower($1) OR cpf = $1`,
      [login]
    );

    const user = rows[0];
    if (!user) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }
    if (!user.is_active) {
      return res.status(403).json({ error: 'Conta suspensa. Entre em contato com o suporte.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    // Atualiza last_login_at
    await query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.id]);

    const { access, refresh } = generateTokens(user.id);

    return res.json({
      token: access,
      refresh_token: refresh,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        plan: user.plan,
        kyc_status: user.kyc_status,
      },
    });
  } catch (err) {
    console.error('Erro no login:', err.message);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

// ── POST /auth/refresh ────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'Refresh token ausente' });

  try {
    const { default: jwt } = await import('jsonwebtoken');
    const decoded = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET);
    const { access } = generateTokens(decoded.userId);
    return res.json({ token: access });
  } catch {
    return res.status(401).json({ error: 'Refresh token inválido ou expirado' });
  }
});

// ── GET /auth/me ──────────────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  const { rows } = await query(
    `SELECT id, full_name, cpf, email, phone, date_of_birth,
            gender, zip_code, street, number, complement,
            neighborhood, city, state, monthly_income,
            occupation, employment_type, plan, kyc_status,
            is_email_verified, open_finance_id, created_at
     FROM users WHERE id = $1`,
    [req.user.id]
  );
  return res.json(rows[0]);
});

export default router;
