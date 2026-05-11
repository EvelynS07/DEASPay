// src/server.js
// ================================================================
// DEASPay Backend — Servidor principal
// Node.js + Express + Neon PostgreSQL
// ================================================================

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import authRouter from './routes/auth.js';
import accountsRouter from './routes/accounts.js';
import scoreRouter from './routes/score.js';
import debtsRouter from './routes/debts.js';
import openFinanceRouter from './routes/openFinance.js';
import providerRouter from './routes/provider.js';

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendIndex = path.resolve(__dirname, '../../index.html');
const PORT = process.env.PORT || 3001;

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

const allowedOrigins = [
  process.env.FRONTEND_URL,
  process.env.NEXT_PUBLIC_APP_URL,
  'https://deas-pay.vercel.app',
  'https://evelyns07.github.io',
]
  .filter(Boolean)
  .flatMap((value) => String(value).split(','))
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);

app.options('*', cors());

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin.replace(/\/$/, ''))) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

app.use(rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 100,
  message: { error: 'Muitas requisições. Tente novamente em alguns minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Muitas tentativas de login. Aguarde 15 minutos.' },
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

app.get('/', (req, res, next) => {
  if (fs.existsSync(frontendIndex)) return res.sendFile(frontendIndex);
  return next();
});

app.get(['/health', '/api/health'], (req, res) => {
  res.json({
    status: 'ok',
    service: 'DEASPay API',
    version: '1.1.0',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
  });
});

app.use('/api/auth', authLimiter, authRouter);
app.use('/api/accounts', accountsRouter);
app.use('/api/score', scoreRouter);
app.use('/api/debts', debtsRouter);
app.use('/api/open-finance', openFinanceRouter);

// Provedor OAuth/Open Finance para outros bancos.
// Caminhos exatos pedidos: /authorize, /token, /provider/accounts
app.use('/', providerRouter);
// Aliases úteis para bancos que esperam /api/oauth/* ou /api/provider/*.
app.use('/api/oauth', providerRouter);
app.use('/api', providerRouter);

app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint não encontrado',
    path: req.originalUrl,
    method: req.method,
  });
});

app.use((err, req, res, next) => {
  console.error('❌ Erro não tratado:', err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: process.env.NODE_ENV === 'production' ? 'Erro interno do servidor' : err.message,
  });
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n🚀 DEASPay API rodando na porta ${PORT}`);
    console.log('📡 Provider OAuth: GET /authorize | POST /token | GET /provider/accounts');
  });
}

export default app;
