// src/database/migrate.js
// ================================================================
// Schema completo do NovaPay
// Execute: node src/database/migrate.js
// Reset:   node src/database/migrate.js --reset
// ================================================================

import { query } from './connection.js';
import 'dotenv/config';

const isReset = process.argv.includes('--reset');

async function migrate() {
  console.log('🔄 Iniciando migration...\n');

  // ──────────────────────────────────────────
  // RESET (apenas em dev)
  // ──────────────────────────────────────────
  if (isReset && process.env.NODE_ENV !== 'production') {
    console.log('⚠️  Resetando banco de dados...');
    await query(`
      DROP TABLE IF EXISTS
        open_finance_consents,
        open_finance_institutions,
        credit_score_history,
        debts,
        transactions,
        accounts,
        cards,
        users
      CASCADE
    `);
    console.log('✅ Tabelas removidas\n');
  }

  // ──────────────────────────────────────────
  // EXTENSÕES
  // ──────────────────────────────────────────
  await query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
  await query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

  // ──────────────────────────────────────────
  // ENUM TYPES
  // ──────────────────────────────────────────
  await query(`
    DO $$ BEGIN
      CREATE TYPE gender_type AS ENUM ('masculino', 'feminino', 'nao_binario', 'nao_informado');
    EXCEPTION WHEN duplicate_object THEN null; END $$
  `);

  await query(`
    DO $$ BEGIN
      CREATE TYPE account_type AS ENUM ('corrente', 'poupanca', 'digital', 'salario');
    EXCEPTION WHEN duplicate_object THEN null; END $$
  `);

  await query(`
    DO $$ BEGIN
      CREATE TYPE transaction_type AS ENUM ('credit', 'debit', 'pix', 'ted', 'doc', 'boleto', 'tarifa');
    EXCEPTION WHEN duplicate_object THEN null; END $$
  `);

  await query(`
    DO $$ BEGIN
      CREATE TYPE transaction_status AS ENUM ('pending', 'completed', 'failed', 'cancelled', 'reversed');
    EXCEPTION WHEN duplicate_object THEN null; END $$
  `);

  await query(`
    DO $$ BEGIN
      CREATE TYPE debt_status AS ENUM ('pending', 'overdue', 'negotiating', 'paid', 'written_off');
    EXCEPTION WHEN duplicate_object THEN null; END $$
  `);

  await query(`
    DO $$ BEGIN
      CREATE TYPE consent_status AS ENUM ('active', 'revoked', 'expired', 'rejected');
    EXCEPTION WHEN duplicate_object THEN null; END $$
  `);

  // ──────────────────────────────────────────
  // TABELA: users
  // Dados cadastrais completos exigidos comercialmente
  // ──────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      full_name         VARCHAR(200) NOT NULL,
      cpf               VARCHAR(14) UNIQUE NOT NULL,
      email             VARCHAR(255) UNIQUE NOT NULL,
      phone             VARCHAR(20) NOT NULL,
      password_hash     TEXT NOT NULL,
      date_of_birth     DATE NOT NULL,
      gender            gender_type NOT NULL DEFAULT 'nao_informado',
      
      -- Endereço
      zip_code          VARCHAR(9),
      street            VARCHAR(255),
      number            VARCHAR(20),
      complement        VARCHAR(100),
      neighborhood      VARCHAR(100),
      city              VARCHAR(100),
      state             CHAR(2),
      
      -- Dados financeiros
      monthly_income    DECIMAL(15,2),
      occupation        VARCHAR(100),
      employment_type   VARCHAR(50),
      
      -- Controle de conta
      is_active         BOOLEAN DEFAULT true,
      is_email_verified BOOLEAN DEFAULT false,
      is_phone_verified BOOLEAN DEFAULT false,
      kyc_status        VARCHAR(20) DEFAULT 'pending', -- pending, approved, rejected
      plan              VARCHAR(20) DEFAULT 'standard', -- standard, premium
      
      -- Open Finance
      open_finance_id   UUID DEFAULT uuid_generate_v4(),
      
      -- Metadados
      last_login_at     TIMESTAMPTZ,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ──────────────────────────────────────────
  // TABELA: accounts
  // Conta bancária vinculada ao usuário
  // ──────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_number    VARCHAR(20) UNIQUE NOT NULL,
      agency            VARCHAR(10) DEFAULT '0001',
      account_type      account_type DEFAULT 'corrente',
      
      -- Saldos
      balance           DECIMAL(15,2) DEFAULT 0.00,
      blocked_balance   DECIMAL(15,2) DEFAULT 0.00, -- valores bloqueados (Ex: cheque especial)
      credit_limit      DECIMAL(15,2) DEFAULT 0.00,
      credit_used       DECIMAL(15,2) DEFAULT 0.00,
      
      -- Pix
      pix_key_cpf       VARCHAR(14),
      pix_key_phone     VARCHAR(20),
      pix_key_email     VARCHAR(255),
      pix_key_random    UUID DEFAULT uuid_generate_v4(),
      
      -- Banco externo (Open Finance)
      external_bank_id  VARCHAR(50),
      external_bank_name VARCHAR(100),
      is_external       BOOLEAN DEFAULT false,
      
      is_active         BOOLEAN DEFAULT true,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ──────────────────────────────────────────
  // TABELA: cards
  // Cartões de crédito e débito
  // ──────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS cards (
      id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      user_id           UUID NOT NULL REFERENCES users(id),
      card_number_hash  TEXT NOT NULL,        -- número criptografado
      last_four         CHAR(4) NOT NULL,
      brand             VARCHAR(20) DEFAULT 'visa',
      card_type         VARCHAR(10) DEFAULT 'credit', -- credit | debit | virtual
      expiry_month      SMALLINT NOT NULL,
      expiry_year       SMALLINT NOT NULL,
      cvv_hash          TEXT NOT NULL,
      credit_limit      DECIMAL(15,2) DEFAULT 0.00,
      invoice_balance   DECIMAL(15,2) DEFAULT 0.00,
      due_day           SMALLINT DEFAULT 10,
      is_blocked        BOOLEAN DEFAULT false,
      is_virtual        BOOLEAN DEFAULT false,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ──────────────────────────────────────────
  // TABELA: transactions
  // Movimentações financeiras — núcleo do extrato
  // ──────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      account_id        UUID NOT NULL REFERENCES accounts(id),
      
      type              transaction_type NOT NULL,
      direction         VARCHAR(6) NOT NULL CHECK (direction IN ('credit', 'debit')),
      status            transaction_status DEFAULT 'pending',
      
      amount            DECIMAL(15,2) NOT NULL CHECK (amount > 0),
      balance_after     DECIMAL(15,2),        -- saldo após transação (snapshot)
      
      description       VARCHAR(255),
      category          VARCHAR(50),           -- alimentação, transporte, saúde...
      
      -- Contraparte
      counterpart_name  VARCHAR(200),
      counterpart_cpf   VARCHAR(14),
      counterpart_bank  VARCHAR(100),
      counterpart_account VARCHAR(50),
      
      -- Pix
      pix_end_to_end_id VARCHAR(32),
      pix_key           VARCHAR(255),
      
      -- Controle
      external_id       VARCHAR(100),          -- ID no banco externo (Open Finance)
      source_bank       VARCHAR(100),          -- banco de origem (Open Finance)
      scheduled_at      TIMESTAMPTZ,
      processed_at      TIMESTAMPTZ,
      
      metadata          JSONB DEFAULT '{}',    -- dados extras flexíveis
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ──────────────────────────────────────────
  // TABELA: debts
  // Inadimplências — negativações e dívidas
  // ──────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS debts (
      id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id           UUID NOT NULL REFERENCES users(id),
      
      creditor_name     VARCHAR(200) NOT NULL,
      creditor_cnpj     VARCHAR(18),
      contract_number   VARCHAR(100),
      
      original_amount   DECIMAL(15,2) NOT NULL,
      current_amount    DECIMAL(15,2) NOT NULL,    -- com juros/multa
      interest_rate     DECIMAL(5,4) DEFAULT 0.02, -- 2% ao mês padrão
      
      due_date          DATE NOT NULL,
      days_overdue      INTEGER DEFAULT 0,
      status            debt_status DEFAULT 'pending',
      
      -- Negativação
      is_blacklisted    BOOLEAN DEFAULT false,     -- negativado no SPC/Serasa
      blacklisted_at    TIMESTAMPTZ,
      blacklisted_bureau VARCHAR(50),              -- 'serasa' | 'spc' | 'boa_vista'
      
      -- Negociação
      negotiation_id    UUID,
      negotiated_amount DECIMAL(15,2),
      negotiated_at     TIMESTAMPTZ,
      paid_at           TIMESTAMPTZ,
      
      -- Open Finance — dívida identificada via OF
      source            VARCHAR(50) DEFAULT 'internal', -- internal | open_finance | serasa
      external_id       VARCHAR(100),
      
      category          VARCHAR(50),             -- saude, telecomunicacoes, servicos...
      
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ──────────────────────────────────────────
  // TABELA: credit_score_history
  // Histórico de score — permite ver evolução
  // ──────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS credit_score_history (
      id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id           UUID NOT NULL REFERENCES users(id),
      
      score             SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 1000),
      
      -- Fatores detalhados (0.0 a 1.0)
      payment_history   DECIMAL(4,3),    -- histórico de pagamentos (35%)
      credit_usage      DECIMAL(4,3),    -- utilização do crédito (30%)
      credit_age        DECIMAL(4,3),    -- tempo de relacionamento (15%)
      credit_mix        DECIMAL(4,3),    -- diversidade de crédito (10%)
      new_inquiries     DECIMAL(4,3),    -- novas consultas (10%)
      
      -- Fonte
      calculated_by     VARCHAR(50) DEFAULT 'novapay', -- novapay | serasa | boa_vista
      open_finance_data BOOLEAN DEFAULT false,
      
      calculated_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ──────────────────────────────────────────
  // TABELA: open_finance_institutions
  // Instituições disponíveis no ecossistema OF
  // ──────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS open_finance_institutions (
      id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name              VARCHAR(200) NOT NULL,
      ispb              VARCHAR(8) UNIQUE NOT NULL,  -- identificador Bacen
      cnpj              VARCHAR(18),
      logo_emoji        VARCHAR(10),
      category          VARCHAR(50),                 -- banco, fintech, cooperativa
      api_base_url      VARCHAR(255),
      is_active         BOOLEAN DEFAULT true,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ──────────────────────────────────────────
  // TABELA: open_finance_consents
  // Consentimentos do usuário por instituição
  // Segue resolução CMN 4.949/2021 (Open Finance BR)
  // ──────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS open_finance_consents (
      id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id           UUID NOT NULL REFERENCES users(id),
      institution_id    UUID NOT NULL REFERENCES open_finance_institutions(id),
      
      consent_id        VARCHAR(100) UNIQUE NOT NULL,  -- ID no diretório OF
      status            consent_status DEFAULT 'active',
      
      -- Permissões granulares (resolução Bacen)
      permissions       JSONB NOT NULL DEFAULT '{
        "accounts": true,
        "balances": true,
        "transactions": true,
        "credit_cards": false,
        "loans": false,
        "investments": false,
        "customers_personal": true,
        "customers_business": false
      }',
      
      -- Dados compartilhados (snapshot do último sync)
      shared_balance    DECIMAL(15,2),
      shared_limit      DECIMAL(15,2),
      last_sync_at      TIMESTAMPTZ,
      sync_error        TEXT,
      
      -- Validade do consentimento (máx 12 meses conforme regulação)
      expires_at        TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 year'),
      revoked_at        TIMESTAMPTZ,
      revocation_reason TEXT,
      
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW(),
      
      UNIQUE(user_id, institution_id)
    )
  `);

  // ──────────────────────────────────────────
  // ÍNDICES — performance nas queries mais frequentes
  // ──────────────────────────────────────────
  await query(`CREATE INDEX IF NOT EXISTS idx_users_cpf ON users(cpf)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_debts_user ON debts(user_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_debts_status ON debts(status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_score_user ON credit_score_history(user_id, calculated_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_consents_user ON open_finance_consents(user_id)`);

  // ──────────────────────────────────────────
  // TRIGGER: updated_at automático
  // ──────────────────────────────────────────
  await query(`
    CREATE OR REPLACE FUNCTION update_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
    $$ LANGUAGE plpgsql
  `);

  for (const table of ['users', 'accounts', 'debts', 'open_finance_consents']) {
    await query(`
      DROP TRIGGER IF EXISTS trg_${table}_updated_at ON ${table};
      CREATE TRIGGER trg_${table}_updated_at
        BEFORE UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION update_updated_at()
    `);
  }

  console.log('✅ Migration concluída com sucesso!\n');
  console.log('Tabelas criadas:');
  console.log('  ✓ users                      — cadastro completo de clientes');
  console.log('  ✓ accounts                   — contas bancárias e saldos');
  console.log('  ✓ cards                      — cartões de crédito/débito');
  console.log('  ✓ transactions               — extrato completo');
  console.log('  ✓ debts                      — inadimplências e negativações');
  console.log('  ✓ credit_score_history       — histórico de score');
  console.log('  ✓ open_finance_institutions  — catálogo de instituições');
  console.log('  ✓ open_finance_consents      — consentimentos do usuário\n');

  process.exit(0);
}

migrate().catch(err => {
  console.error('❌ Falha na migration:', err.message);
  process.exit(1);
});
