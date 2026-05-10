// src/server.js
// ================================================================
// NovaPay Backend — Servidor principal
// Node.js + Express + Neon PostgreSQL
// ================================================================

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import 'dotenv/config';

// Rotas
import authRouter       from './routes/auth.js';
import accountsRouter   from './routes/accounts.js';
import scoreRouter      from './routes/score.js';
import debtsRouter      from './routes/debts.js';
import openFinanceRouter from './routes/openFinance.js';

const app = express();
const PORT = process.env.PORT || 3001;

// ── Segurança ─────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

// Rate limiting global — evita força bruta
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  message: { error: 'Muitas requisições. Tente novamente em alguns minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Rate limiting específico para auth — mais restritivo
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Muitas tentativas de login. Aguarde 15 minutos.' },
});

// ── Parsers ───────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Logs ──────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

// ── Health Check ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'NovaPay API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
  });
});

// ── Rotas da API ──────────────────────────────────────────────
app.use('/api/auth',         authLimiter, authRouter);
app.use('/api/accounts',     accountsRouter);
app.use('/api/score',        scoreRouter);
app.use('/api/debts',        debtsRouter);
app.use('/api/open-finance', openFinanceRouter);

// ── 404 ───────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint não encontrado',
    path: req.originalUrl,
    method: req.method,
  });
});

// ── Error handler global ──────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('❌ Erro não tratado:', err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Erro interno do servidor'
      : err.message,
  });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║       NovaPay Backend  v1.0.0          ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`\n🚀 Servidor rodando em: http://localhost:${PORT}`);
  console.log(`🌿 Ambiente: ${process.env.NODE_ENV || 'development'}`);
  console.log(`\n📡 Endpoints disponíveis:`);
  console.log(`   GET  /health`);
  console.log(`   POST /api/auth/register`);
  console.log(`   POST /api/auth/login`);
  console.log(`   GET  /api/auth/me`);
  console.log(`   GET  /api/accounts`);
  console.log(`   GET  /api/accounts/:id/transactions`);
  console.log(`   POST /api/accounts/:id/pix`);
  console.log(`   GET  /api/score`);
  console.log(`   GET  /api/score/history`);
  console.log(`   POST /api/score/recalculate`);
  console.log(`   GET  /api/debts`);
  console.log(`   POST /api/debts/:id/negotiate`);
  console.log(`   POST /api/debts/:id/pay`);
  console.log(`   GET  /api/open-finance/institutions`);
  console.log(`   GET  /api/open-finance/consents`);
  console.log(`   POST /api/open-finance/consent`);
  console.log(`   POST /api/open-finance/sync/:id`);
  console.log(`\n📊 Banco de dados: Neon PostgreSQL\n`);
});

export default app;
