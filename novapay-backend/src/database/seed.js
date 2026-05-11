// src/database/seed.js
// Popula apenas instituições Open Finance.
// Não cria usuário/conta fixa: as contas agora são reais, criadas via cadastro.

import { query } from './connection.js';
import 'dotenv/config';

async function seed() {
  console.log('🌱 Iniciando seed de instituições...\n');

  await query(`
    INSERT INTO open_finance_institutions (name, ispb, cnpj, logo_emoji, category, api_base_url)
    VALUES
      ('Larabank', '99990001', '99.990.001/0001-00', '💠', 'fintech', 'https://larabankdigital2.vercel.app'),
      ('Banco do Brasil', '00000000', '00.000.000/0001-91', '🏦', 'banco', 'https://opendata.bb.com.br/open-banking/v1'),
      ('Itaú Unibanco', '60701190', '60.701.190/0001-04', '🟠', 'banco', 'https://ib.itau.com.br/open-banking/v1'),
      ('Nubank', '18236120', '18.236.120/0001-58', '💚', 'fintech', 'https://api.nubank.com.br/open-banking/v1'),
      ('Bradesco', '60746948', '60.746.948/0001-12', '🔴', 'banco', 'https://api.bradesco.com/open-banking/v1'),
      ('Caixa Econômica Federal', '36026338', '00.360.305/0001-04', '🏛', 'banco', 'https://api.caixa.gov.br/open-banking/v1'),
      ('Santander', '90400888', '90.400.888/0001-42', '❤', 'banco', 'https://api.santander.com.br/open-banking/v1'),
      ('Inter', '00416968', '00.416.968/0001-01', '🟧', 'fintech', 'https://cdpj.partners.bancointer.com.br/open-banking/v1'),
      ('C6 Bank', '31872495', '31.872.495/0001-72', '⬛', 'fintech', 'https://api.c6bank.com.br/open-banking/v1')
    ON CONFLICT (ispb) DO UPDATE SET
      name = EXCLUDED.name,
      cnpj = EXCLUDED.cnpj,
      logo_emoji = EXCLUDED.logo_emoji,
      category = EXCLUDED.category,
      api_base_url = EXCLUDED.api_base_url,
      is_active = true
  `);

  console.log('✅ Instituições inseridas/atualizadas');
  console.log('✅ Nenhuma conta demo foi criada. Cadastre usuários reais pelo site.\n');
  process.exit(0);
}

seed().catch(err => {
  console.error('❌ Erro no seed:', err.message);
  process.exit(1);
});
