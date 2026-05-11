-- Rode no Neon do DEASPay para remover instituições falsas da tela Open Finance.
UPDATE open_finance_institutions
SET is_active = false
WHERE ispb NOT IN ('99990001', '88880001');

INSERT INTO open_finance_institutions
  (name, ispb, cnpj, logo_emoji, category, api_base_url, is_active)
VALUES
  ('Larabank', '99990001', '99.990.001/0001-00', '💠', 'fintech', 'https://larabankdigital2.vercel.app', true),
  ('Deas Finance', '88880001', '88.880.001/0001-00', '🟣', 'fintech', 'https://deas-three.vercel.app', true)
ON CONFLICT (ispb) DO UPDATE SET
  name = EXCLUDED.name,
  cnpj = EXCLUDED.cnpj,
  logo_emoji = EXCLUDED.logo_emoji,
  category = EXCLUDED.category,
  api_base_url = EXCLUDED.api_base_url,
  is_active = true;
