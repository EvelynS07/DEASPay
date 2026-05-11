// src/database/connection.js
// ================================================================
// Conexão com Neon PostgreSQL via pool de conexões
// Neon usa WebSockets para conexões serverless — importamos o
// driver @neondatabase/serverless que lida com isso automaticamente
// ================================================================

import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import 'dotenv/config';

// Necessário para ambiente Node.js (Neon usa WebSocket nativamente
// em Edge/Workers, mas em Node precisamos injetar o polyfill)
neonConfig.webSocketConstructor = ws;

// Pool de conexões — mantém conexões abertas para reutilização,
// reduzindo latência em endpoints de alta frequência (extrato, saldo)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,               // máx conexões simultâneas
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: { rejectUnauthorized: false },
});

// Verifica conexão na inicialização
pool.on('connect', () => {
  if (process.env.NODE_ENV === 'development') {
    console.log('✅ Neon PostgreSQL conectado');
  }
});

pool.on('error', (err) => {
  console.error('❌ Erro no pool de conexão Neon:', err.message);
});

// Helper: executa query com log em dev
export async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    if (process.env.NODE_ENV === 'development') {
      console.log(`🔍 Query [${Date.now() - start}ms]:`, text.slice(0, 80));
    }
    return result;
  } catch (error) {
    console.error('❌ Erro na query:', error.message);
    console.error('SQL:', text);
    throw error;
  }
}

// Helper: transação — garante atomicidade em operações como
// transferências (débito + crédito devem ser inseparáveis)
export async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export default pool;
