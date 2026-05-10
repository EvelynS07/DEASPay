# NovaPay Backend 🏦

Backend completo do banco digital NovaPay com Open Finance integrado.

---

## 🗄️ Por que Neon PostgreSQL?

O **Neon** foi escolhido sobre alternativas como Supabase, PlanetScale ou Railway por três razões centrais:

### 1. PostgreSQL nativo — sem compromissos
Banco digital exige transações ACID reais. O Neon roda PostgreSQL puro (15+), então tudo que o PostgreSQL suporta — transações atômicas, triggers, JSONB, índices parciais, window functions — funciona sem adaptadores ou ORMs limitantes. Operações como **debitar uma conta e creditar outra no mesmo `BEGIN/COMMIT`** funcionam exatamente como esperado.

### 2. Serverless com conexões persistentes
O driver `@neondatabase/serverless` usa WebSocket para manter conexões vivas em ambientes serverless (Vercel, Railway, Render), eliminando o cold-start de TCP que é fatal em endpoints de alta frequência como saldo e extrato. Em Node.js tradicional, o pool de conexões (`pg.Pool`) é usado normalmente.

### 3. Branching de banco de dados
O Neon permite criar **branches do banco** (como Git branches) para testar migrations em staging sem tocar em produção — essencial para um banco digital onde um schema errado pode corromper saldos.

### Alternativas consideradas
| Solução | Por que não? |
|---|---|
| **Supabase** | Bom, mas adiciona camada Supabase Auth que conflita com o JWT próprio do NovaPay |
| **PlanetScale** | MySQL — não tem suporte nativo a JSONB (usado nos `permissions` de Open Finance) nem a `uuid-ossp` |
| **Railway Postgres** | Sem branching, sem serverless driver otimizado |
| **RDS Aurora** | Excelente, mas custo alto e setup complexo para MVP |

---

## 📁 Estrutura do Projeto

```
novapay-backend/
├── src/
│   ├── server.js                  # Entry point Express
│   ├── database/
│   │   ├── connection.js          # Pool Neon + helpers query/withTransaction
│   │   ├── migrate.js             # Schema completo (8 tabelas)
│   │   └── seed.js                # Dados demo realistas
│   ├── middleware/
│   │   └── auth.js                # JWT authenticate + generateTokens
│   └── routes/
│       ├── auth.js                # Register, Login, Refresh, /me
│       ├── accounts.js            # Contas, saldo, extrato, Pix
│       ├── score.js               # Score + motor de cálculo FICO-BR
│       ├── debts.js               # Inadimplências, negociação, pagamento
│       └── openFinance.js         # Consentimentos + sync Open Finance
├── .env.example
├── package.json
└── README.md
```

---

## 🗃️ Schema do Banco

```
users ──────────────────────────────────────────────────
  id, full_name, cpf (unique), email (unique), phone
  password_hash, date_of_birth, gender
  zip_code, street, number, city, state
  monthly_income, occupation, employment_type
  kyc_status, plan, open_finance_id
  is_active, is_email_verified, last_login_at

accounts ──────────────────────────────────────────────
  id, user_id → users
  account_number (unique), agency, account_type
  balance, blocked_balance
  credit_limit, credit_used
  pix_key_cpf, pix_key_phone, pix_key_email, pix_key_random
  external_bank_id, external_bank_name, is_external

cards ─────────────────────────────────────────────────
  id, account_id → accounts, user_id → users
  card_number_hash, last_four, brand, card_type
  expiry_month, expiry_year, cvv_hash
  credit_limit, invoice_balance, due_day

transactions ──────────────────────────────────────────
  id, account_id → accounts
  type (credit/debit/pix/ted/doc/boleto/tarifa)
  direction, status, amount, balance_after
  description, category
  counterpart_name, counterpart_bank
  pix_end_to_end_id, source_bank
  metadata (JSONB)

debts ─────────────────────────────────────────────────
  id, user_id → users
  creditor_name, creditor_cnpj, contract_number
  original_amount, current_amount, interest_rate
  due_date, days_overdue, status
  is_blacklisted, blacklisted_bureau
  negotiated_amount, source (internal/open_finance/serasa)

credit_score_history ──────────────────────────────────
  id, user_id → users
  score (0–1000)
  payment_history, credit_usage, credit_age,
  credit_mix, new_inquiries (fatores 0.0–1.0)
  open_finance_data, calculated_by

open_finance_institutions ─────────────────────────────
  id, name, ispb (Bacen), cnpj
  logo_emoji, category, api_base_url

open_finance_consents ─────────────────────────────────
  id, user_id → users, institution_id → institutions
  consent_id, status, permissions (JSONB)
  shared_balance, shared_limit, last_sync_at
  expires_at (máx 1 ano — resolução CMN 4.949/2021)
```

---

## 🔌 API Endpoints

### Auth
```
POST   /api/auth/register          Cadastro completo
POST   /api/auth/login             Login → JWT
POST   /api/auth/refresh           Renova token
GET    /api/auth/me                Perfil autenticado
```

### Contas
```
GET    /api/accounts               Lista contas do usuário
GET    /api/accounts/:id/balance   Saldo em tempo real
GET    /api/accounts/:id/transactions  Extrato paginado + filtros
POST   /api/accounts/:id/pix       Transferência Pix
```

### Score
```
GET    /api/score                  Score atual + fatores
GET    /api/score/history          Evolução histórica
POST   /api/score/recalculate      Força recálculo
```

### Inadimplências
```
GET    /api/debts                  Lista dívidas + resumo
GET    /api/debts/:id              Detalhe de dívida
POST   /api/debts/:id/negotiate    Proposta de negociação
POST   /api/debts/:id/pay         Registra pagamento
```

### Open Finance
```
GET    /api/open-finance/institutions   Catálogo de bancos
GET    /api/open-finance/consents       Consentimentos ativos
POST   /api/open-finance/consent        Autoriza compartilhamento
DELETE /api/open-finance/consent/:id    Revoga consentimento
POST   /api/open-finance/sync/:instId   Força sincronização
GET    /api/open-finance/summary        Resumo consolidado
```

---

## ⚙️ Motor de Score (FICO-BR)

O score é calculado com 5 fatores ponderados, inspirado no modelo FICO adaptado ao contexto brasileiro:

| Fator | Peso | Como é calculado |
|---|---|---|
| Histórico de pagamentos | **35%** | Penaliza dívidas vencidas e negativações no SPC/Serasa |
| Utilização do crédito | **30%** | Razão `credit_used / credit_limit` — ideal < 30% |
| Tempo de relacionamento | **15%** | Meses desde o cadastro (máx 60 meses = 100%) |
| Mix de crédito | **10%** | Diversidade de tipos de transação |
| Novas consultas | **10%** | Volume de débitos recentes (proxy de risco) |
| Bônus Open Finance | +2%/banco | Cada banco conectado adiciona 2% ao score |

---

## 🚀 Como rodar

### 1. Configure o Neon
```bash
# 1. Crie uma conta em https://console.neon.tech (gratuito)
# 2. Crie um projeto chamado "novapay"
# 3. Copie a connection string (DATABASE_URL)
```

### 2. Instale e configure
```bash
cd novapay-backend
npm install
cp .env.example .env
# Edite .env com sua DATABASE_URL do Neon
```

### 3. Banco de dados
```bash
npm run db:migrate    # Cria as 8 tabelas
npm run db:seed       # Insere dados demo
```

### 4. Servidor
```bash
npm run dev           # Desenvolvimento (hot reload)
npm start             # Produção
```

### 5. Teste rápido
```bash
curl http://localhost:3001/health

curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"ana@novapay.com","password":"Novapay@123"}'
```

---

## 🛡️ Segurança implementada

- **Senhas**: bcrypt com 12 rounds
- **JWT**: access token (7d) + refresh token (30d) separados
- **Rate limiting**: 100 req/15min global, 10 req/15min em `/auth`
- **Helmet**: headers HTTP seguros
- **Transações atômicas**: `withTransaction()` garante consistência em Pix/pagamentos
- **Validação**: `express-validator` em todos os endpoints de escrita
- **CPF/e-mail únicos**: constraint no banco, não só na aplicação

---

## 📦 Deploy sugerido

| Camada | Serviço | Por quê |
|---|---|---|
| **API** | Railway ou Render | Deploy automático via Git, SSL grátis |
| **Banco** | Neon PostgreSQL | Serverless, branching, plano gratuito generoso |
| **Frontend** | Vercel ou Netlify | CDN global, preview deployments |

```bash
# Deploy no Railway (exemplo)
railway login
railway init
railway add --plugin postgresql  # ou use Neon via DATABASE_URL
railway up
```
