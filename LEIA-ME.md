# Wolfs LTDA Investimentos — loja e crediário

- **Site dos clientes:** `index.html` (vitrine, simulação Pix/cartão e aba "Simular crediário")
- **Painel de controle:** `admin.html` (abre em `/admin`): visão geral, estoque, vendas, cobranças, clientes, produtos, preços de mercado e meta. Entra com a senha do segredo `WOLFS_SENHA`. O código que liga ao servidor está em `wolfs-conexao.js`.
- **Site: pedidos e vitrine:** `loja.html` (abre em `/loja`): pedidos que chegam pelo site, produtos da vitrine e regras do crediário.
- **Servidor e banco:** Supabase, projeto `rifa-sorte-online` (São Paulo), Edge Function `wolfs` e tabelas `wolfs_*`. Não mexe em nada da rifa. Código em `supabase/functions/wolfs/index.ts`.
- **Imagens fixas:** pasta `fotos/` (banner e logo). Fotos dos produtos são enviadas pelo painel.

No painel dá para mudar produtos, preços, fotos, WhatsApp, textos, entrada mínima, parcelas, dias de vencimento, taxas do cartão e juros do crediário (no máximo 1% ao mês). Os pedidos do site aparecem no painel na hora; o botão "Copiar para o painel" leva o pedido para o painel de controle da Wolfs no Claude.

Para trocar a senha: no Supabase, em Edge Functions → Secrets, edite `WOLFS_SENHA`.
