// src/database/seed.js
// Popula o banco com dados realistas para desenvolvimento/demo

import { query, withTransaction } from './connection.js';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import 'dotenv/config';

async function seed() {
  console.log('🌱 Iniciando seed...\n');

  // ── Instituições Open Finance ──────────────────────────────
  await query(`
    INSERT INTO open_finance_institutions (name, ispb, cnpj, logo_emoji, category, api_base_url)
    VALUES
      ('Banco do Brasil', '00000000', '00.000.000/0001-91', '🏦', 'banco', 'https://opendata.bb.com.br/open-banking/v1'),
      ('Itaú Unibanco', '60701190', '60.701.190/0001-04', '🟠', 'banco', 'https://ib.itau.com.br/open-banking/v1'),
      ('Nubank', '18236120', '18.236.120/0001-58', '💚', 'fintech', 'https://api.nubank.com.br/open-banking/v1'),
      ('Bradesco', '60746948', '60.746.948/0001-12', '🔴', 'banco', 'https://api.bradesco.com/open-banking/v1'),
      ('Caixa Econômica Federal', '36026338', '00.360.305/0001-04', '🏛', 'banco', 'https://api.caixa.gov.br/open-banking/v1'),
      ('Santander', '90400888', '90.400.888/0001-42', '❤', 'banco', 'https://api.santander.com.br/open-banking/v1'),
      ('Inter', '00416968', '00.416.968/0001-01', '🟧', 'fintech', 'https://cdpj.partners.bancointer.com.br/open-banking/v1'),
      ('C6 Bank', '31872495', '31.872.495/0001-72', '⬛', 'fintech', 'https://api.c6bank.com.br/open-banking/v1')
    ON CONFLICT (ispb) DO NOTHING
  `);
  console.log('✅ Instituições Open Finance inseridas');

  // ── Usuário demo ──────────────────────────────────────────
  const passwordHash = await bcrypt.hash('Novapay@123', 12);
  const userId = uuidv4();
  const accountId = uuidv4();

  await withTransaction(async (client) => {
    await client.query(`
      INSERT INTO users (
        id, full_name, cpf, email, phone, password_hash,
        date_of_birth, gender, zip_code, street, number,
        neighborhood, city, state, monthly_income, occupation,
        employment_type, is_email_verified, kyc_status, plan
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      ON CONFLICT (cpf) DO NOTHING
    `, [
      userId, 'Ana Carolina Silva', '123.456.789-00',
      'ana@novapay.com', '(81) 99999-1234', passwordHash,
      '1995-06-15', 'feminino', '50710-010',
      'Rua das Flores', '42', 'Centro',
      'São Lourenço da Mata', 'PE', 5500.00,
      'Analista de Sistemas', 'clt',
      true, 'approved', 'premium'
    ]);

    // Conta principal
    await client.query(`
      INSERT INTO accounts (
        id, user_id, account_number, account_type,
        balance, credit_limit, credit_used,
        pix_key_cpf, pix_key_email
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (account_number) DO NOTHING
    `, [
      accountId, userId, '00042-1', 'corrente',
      4820.50, 12000.00, 4800.00,
      '123.456.789-00', 'ana@novapay.com'
    ]);

    // Transações
    const transactions = [
      { type: 'credit', dir: 'credit', amount: 5500.00, desc: 'Salário — TechCorp Ltda', cat: 'salario', name: 'TechCorp Ltda', days: 8 },
      { type: 'debit',  dir: 'debit',  amount: 320.00,  desc: 'Supermercado Atacadão',    cat: 'alimentacao', name: 'Atacadão', days: 7 },
      { type: 'pix',    dir: 'credit', amount: 1400.00, desc: 'Pix recebido',              cat: 'transferencia', name: 'Pedro Melo', days: 6 },
      { type: 'debit',  dir: 'debit',  amount: 89.90,   desc: 'Farmácia São João',         cat: 'saude', name: 'Farmácia São João', days: 6 },
      { type: 'debit',  dir: 'debit',  amount: 180.00,  desc: 'Combustível Shell',         cat: 'transporte', name: 'Shell', days: 5 },
      { type: 'debit',  dir: 'debit',  amount: 95.00,   desc: 'Restaurante Churrascaria',  cat: 'alimentacao', name: 'Churrascaria do Boi', days: 4 },
      { type: 'pix',    dir: 'credit', amount: 200.00,  desc: 'Pix João Santos',           cat: 'transferencia', name: 'João Santos', days: 4 },
      { type: 'debit',  dir: 'debit',  amount: 37.00,   desc: 'Netflix',                   cat: 'entretenimento', name: 'Netflix', days: 3 },
      { type: 'boleto', dir: 'debit',  amount: 187.00,  desc: 'CELPE — Energia Elétrica',  cat: 'moradia', name: 'CELPE', days: 2 },
      { type: 'boleto', dir: 'debit',  amount: 99.90,   desc: 'Internet Claro Fibra',      cat: 'moradia', name: 'Claro', days: 1 },
    ];

    let runningBalance = 4820.50;
    for (const tx of transactions) {
      const date = new Date();
      date.setDate(date.getDate() - tx.days);
      await client.query(`
        INSERT INTO transactions (
          account_id, type, direction, status, amount,
          balance_after, description, category,
          counterpart_name, processed_at
        ) VALUES ($1,$2,$3,'completed',$4,$5,$6,$7,$8,$9)
      `, [
        accountId, tx.type, tx.dir, tx.amount,
        runningBalance, tx.desc, tx.cat,
        tx.name, date
      ]);
      runningBalance += tx.dir === 'credit' ? tx.amount : -tx.amount;
    }

    // Dívidas / inadimplências
    const dueOld = new Date(); dueOld.setDate(dueOld.getDate() - 58);
    const dueMid = new Date(); dueMid.setDate(dueMid.getDate() - 36);
    await client.query(`
      INSERT INTO debts (
        user_id, creditor_name, contract_number,
        original_amount, current_amount, due_date,
        days_overdue, status, is_blacklisted,
        blacklisted_at, blacklisted_bureau, category
      ) VALUES
        ($1,'Clínica São Lucas','#2024-8821',1200.00,1356.00,$2,58,'overdue',true,$3,'serasa','saude'),
        ($1,'Operadora Vivo','#4490-B',340.00,362.00,$4,36,'overdue',false,null,null,'telecomunicacoes')
    `, [userId, dueOld, dueOld, dueMid]);

    // Score inicial
    await client.query(`
      INSERT INTO credit_score_history (
        user_id, score, payment_history, credit_usage,
        credit_age, credit_mix, new_inquiries,
        open_finance_data
      ) VALUES ($1,582,0.38,0.60,0.75,0.70,0.55,true)
    `, [userId]);

    // Consentimentos Open Finance
    const [bbRow, itauRow, nuRow] = await Promise.all([
      client.query(`SELECT id FROM open_finance_institutions WHERE ispb='00000000'`),
      client.query(`SELECT id FROM open_finance_institutions WHERE ispb='60701190'`),
      client.query(`SELECT id FROM open_finance_institutions WHERE ispb='18236120'`),
    ]);

    if (bbRow.rows[0]) {
      await client.query(`
        INSERT INTO open_finance_consents (user_id, institution_id, consent_id, status, shared_balance, shared_limit, last_sync_at)
        VALUES ($1,$2,'urn:novapay:consent:bb-001','active',2340.00,5000.00,NOW())
        ON CONFLICT (user_id, institution_id) DO NOTHING
      `, [userId, bbRow.rows[0].id]);
    }
    if (itauRow.rows[0]) {
      await client.query(`
        INSERT INTO open_finance_consents (user_id, institution_id, consent_id, status, shared_balance, shared_limit, last_sync_at)
        VALUES ($1,$2,'urn:novapay:consent:itau-001','active',null,12000.00,NOW())
        ON CONFLICT (user_id, institution_id) DO NOTHING
      `, [userId, itauRow.rows[0].id]);
    }
    if (nuRow.rows[0]) {
      await client.query(`
        INSERT INTO open_finance_consents (user_id, institution_id, consent_id, status, shared_balance, last_sync_at)
        VALUES ($1,$2,'urn:novapay:consent:nu-001','revoked',480.50,NOW())
        ON CONFLICT (user_id, institution_id) DO NOTHING
      `, [userId, nuRow.rows[0].id]);
    }
  });

  console.log('✅ Usuário demo criado');
  console.log('   📧 Email:  ana@novapay.com');
  console.log('   🔑 Senha:  Novapay@123');
  console.log('   📄 CPF:    123.456.789-00\n');
  console.log('✅ Seed concluído!\n');
  process.exit(0);
}

seed().catch(err => {
  console.error('❌ Erro no seed:', err.message);
  process.exit(1);
});