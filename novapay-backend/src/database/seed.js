// src/database/seed.js
// Popula apenas instituições Open Finance reais do projeto.
// Não cria usuário/conta fixa: todo usuário precisa fazer cadastro e login.

import { query } from './connection.js';
import 'dotenv/config';

async function seed() {
  console.log('🌱 Iniciando seed de instituições reais...\n');

  await query(`
    UPDATE open_finance_institutions
    SET is_active = false
    WHERE ispb NOT IN ('99990001', '88880001')
  `);

  await query(`
    INSERT INTO open_finance_institutions (name, ispb, cnpj, logo_emoji, category, api_base_url, is_active)
    VALUES
      ('Larabank', '99990001', '99.990.001/0001-00', '💠', 'fintech', 'https://larabankdigital-82k2.vercel.app', true),
      ('Deas Finance', '88880001', '88.880.001/0001-00', '🟣', 'fintech', 'https://deas-three.vercel.app', true)
    ON CONFLICT (ispb) DO UPDATE SET
      name = EXCLUDED.name,
      cnpj = EXCLUDED.cnpj,
      logo_emoji = EXCLUDED.logo_emoji,
      category = EXCLUDED.category,
      api_base_url = EXCLUDED.api_base_url,
      is_active = true
  `);

  console.log('✅ Instituições reais cadastradas: Larabank e Deas Finance');
  console.log('✅ Bancos fictícios/desconectados foram desativados');
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Erro no seed:', err);
    process.exit(1);
  });
