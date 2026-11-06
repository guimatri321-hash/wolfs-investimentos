// Servidor da loja Wolfs LTDA Investimentos (Supabase Edge Function "wolfs").
// Tabelas: wolfs_config, wolfs_produtos, wolfs_pedidos, wolfs_imagens, wolfs_docs. Não usa nada da rifa.
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";
import { Buffer } from "node:buffer";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "") + "/functions/v1/wolfs";
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 3, idle_timeout: 20 });
const q = async (text: string, params: unknown[] = []) => [...(await sql.unsafe(text, params as any[]))] as any[];

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, x-admin-token, authorization, apikey, x-client-info",
  "access-control-max-age": "86400",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const erro = (mensagem: string, status = 400) => json({ erro: mensagem }, status);
class HttpErro extends Error { constructor(public status: number, msg: string) { super(msg); } }

const soDigitos = (s: unknown) => String(s ?? "").replace(/\D/g, "");
const texto = (s: unknown, max = 200) => String(s ?? "").trim().slice(0, max);
const centavos = (v: unknown) => Math.round(Number(v) * 100);
function cpfValido(c: string) {
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  for (const t of [9, 10]) {
    let s = 0;
    for (let i = 0; i < t; i++) s += Number(c[i]) * (t + 1 - i);
    if (((s * 10) % 11) % 10 !== Number(c[t])) return false;
  }
  return true;
}

/* ---------------- Configurações ---------------- */
const COLECOES = ["estoque", "clientes", "vendas", "mercado", "config"];
const CATEGORIAS = ["iPhone", "Celular", "Fone de ouvido", "Relógio", "Caixa de som", "Informática", "Games", "Casa", "Beleza", "Perfumes", "Moda", "Acessórios", "Outro"];
const CONFIG_PADRAO = {
  nomeSite: "Wolfs LTDA Investimentos",
  chamada: "iPhone, AirPods e eletrônicos em até 12x no cartão ou no crediário Wolfs.",
  whatsapp: "",
  cidade: "Campo Grande, MS",
  entradaMin: 10,          // % mínimo de entrada no crediário
  credMax: 10,             // máximo de parcelas do crediário
  jurosMes: 1,             // % ao mês no crediário (limite legal: 1)
  valorLivre: true,        // cliente pode simular um valor que não está na vitrine
  diasVencimento: [5, 10, 15, 20, 25],
  cartaoMax: 12,
  taxasCartao: { 1: 3.15, 2: 5.39, 3: 6.12, 4: 6.85, 5: 7.57, 6: 8.28, 7: 8.99, 8: 9.69, 9: 10.38, 10: 11.06, 11: 11.74, 12: 12.4 } as Record<string, number>,
  avisoAprovacao: "Em alguns instantes um vendedor da Wolfs entrará em contato pelo WhatsApp sobre a aprovação do seu crediário.",
  avisoPedido: "Recebemos seu pedido! Em alguns instantes um vendedor da Wolfs vai falar com você pelo WhatsApp.",
  rodape: "Preços sujeitos à confirmação de estoque. Seminovos com bateria e IMEI conferidos.",
};
type Config = typeof CONFIG_PADRAO;
async function lerConfig(): Promise<Config> {
  const r = (await q("SELECT dados FROM wolfs_config WHERE id = 1"))[0];
  return { ...CONFIG_PADRAO, ...(r?.dados || {}) };
}
function limparConfig(c: any): Partial<Config> {
  const out: any = {};
  const num = (v: unknown, a: number, b: number) => Math.min(b, Math.max(a, Number(v)));
  if ("nomeSite" in c) out.nomeSite = texto(c.nomeSite, 80) || CONFIG_PADRAO.nomeSite;
  if ("chamada" in c) out.chamada = texto(c.chamada, 200);
  if ("whatsapp" in c) out.whatsapp = soDigitos(c.whatsapp).slice(0, 13);
  if ("cidade" in c) out.cidade = texto(c.cidade, 80);
  if ("entradaMin" in c) out.entradaMin = Math.round(num(c.entradaMin, 0, 90));
  if ("credMax" in c) out.credMax = Math.round(num(c.credMax, 1, 24));
  if ("jurosMes" in c) out.jurosMes = Math.round(num(c.jurosMes, 0, 1) * 100) / 100; // nunca acima de 1% a.m.
  if ("valorLivre" in c) out.valorLivre = !!c.valorLivre;
  if ("diasVencimento" in c && Array.isArray(c.diasVencimento)) out.diasVencimento = [...new Set(c.diasVencimento.map((d: unknown) => Math.round(Number(d))).filter((d: number) => d >= 1 && d <= 28))].sort((a: any, b: any) => a - b).slice(0, 10);
  if ("cartaoMax" in c) out.cartaoMax = Math.round(num(c.cartaoMax, 1, 12));
  if ("taxasCartao" in c && c.taxasCartao && typeof c.taxasCartao === "object") {
    out.taxasCartao = {};
    for (let n = 1; n <= 12; n++) out.taxasCartao[n] = Math.round(num(c.taxasCartao[n] ?? CONFIG_PADRAO.taxasCartao[n], 0, 40) * 100) / 100;
  }
  for (const k of ["avisoAprovacao", "avisoPedido", "rodape"]) if (k in c) out[k] = texto(c[k], 300);
  return out;
}

/* ---------------- Contas ---------------- */
function parcelaPrice(resto: number, n: number, jurosMes: number) {
  const i = Math.min(Math.max(jurosMes, 0), 1) / 100;
  return i > 0 ? resto * i / (1 - Math.pow(1 + i, -n)) : resto / n;
}
function somaMeses(iso: string, k: number) {
  const [y, m, d] = iso.split("-").map(Number);
  const a = new Date(Date.UTC(y, m - 1 + k, 1));
  const ult = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + 1, 0)).getUTCDate();
  a.setUTCDate(Math.min(d, ult));
  return a.toISOString().slice(0, 10);
}
function hojeSP() { return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); }
function primeiroVencimento(dia: number) {
  const h = hojeSP();
  const [y, m] = h.split("-").map(Number);
  let alvo = new Date(Date.UTC(y, m, dia)); // mês seguinte
  if ((alvo.getTime() - new Date(h + "T00:00:00Z").getTime()) / 864e5 < 20) alvo = new Date(Date.UTC(y, m + 1, dia));
  return alvo.toISOString().slice(0, 10);
}
const codigoPedido = () => "W" + randomBytes(4).toString("hex").toUpperCase().slice(0, 6);

/* ---------------- Formatação ---------------- */
const produtoPublico = (p: any) => ({
  id: Number(p.id), nome: p.nome, categoria: p.categoria, condicao: p.condicao, preco: p.preco_centavos / 100,
  descricao: p.descricao || "", imagem: p.imagem ? (/^https:\/\//.test(p.imagem) ? p.imagem : `${BASE}/imagem/${p.imagem}`) : null, imagemChave: p.imagem || null,
  ativo: p.ativo, ordem: p.ordem,
});
const configPublica = (c: Config) => ({ ...c, categorias: CATEGORIAS });
function pedidoAdmin(p: any) {
  return {
    id: Number(p.id), codigo: p.codigo, criadoEm: p.criado_em, status: p.status, forma: p.forma,
    produtoNome: p.produto_nome, categoria: p.categoria, condicao: p.condicao,
    preco: p.preco_centavos / 100, entrada: p.entrada_centavos / 100, parcelas: p.parcelas,
    valorParcela: p.valor_parcela_centavos != null ? p.valor_parcela_centavos / 100 : null,
    jurosMes: Number(p.juros_mes), taxaCartao: Number(p.taxa_cartao), total: p.total_centavos / 100,
    diaVencimento: p.dia_vencimento, primeiroVenc: p.primeiro_venc ? String(p.primeiro_venc instanceof Date ? p.primeiro_venc.toISOString() : p.primeiro_venc).slice(0, 10) : null,
    nome: p.nome, cpf: p.cpf, telefone: p.telefone, cep: p.cep,
    rua: p.rua, numero: p.numero, complemento: p.complemento, bairro: p.bairro, cidade: p.cidade, uf: p.uf,
    emergNome: p.emerg_nome, emergParentesco: p.emerg_parentesco, emergTel: p.emerg_tel, obsAdmin: p.obs_admin || "",
  };
}

/* ---------------- Aviso no WhatsApp do dono (CallMeBot) ---------------- */
// Precisa do segredo WOLFS_WA_APIKEY no Supabase e do WhatsApp em Configurações. Sem CPF nem endereço na mensagem.
async function avisarDono(cfg: Config, p: any) {
  const key = Deno.env.get("WOLFS_WA_APIKEY") || "";
  const num = soDigitos(cfg.whatsapp);
  if (!key || num.length < 10) return;
  const fone = num.length <= 11 ? "55" + num : num;
  const br = (v: number) => "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const plano = p.forma === "Crediário próprio"
    ? `Entrada ${br(p.entrada)} + ${p.parcelas}x de ${br(p.valorParcela)} (vence dia ${p.diaVencimento}, 1ª em ${p.primeiroVenc?.split("-").reverse().join("/")})`
    : p.forma === "Pix" ? `${br(p.total)} no Pix` : `${p.parcelas}x de ${br(p.valorParcela)} no cartão`;
  const msg = [
    p.forma === "Crediário próprio" ? "*Novo crediário no site Wolfs*" : "*Novo pedido no site Wolfs*",
    `Pedido: ${p.codigo}`, `Cliente: ${p.nome}`, `WhatsApp: ${p.telefone}`,
    `Produto: ${p.produtoNome} (${br(p.preco)} à vista)`, plano,
    "Dados completos em wolfs-investimentos.pages.dev/loja",
  ].join("\n");
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(`https://api.callmebot.com/whatsapp.php?phone=${fone}&text=${encodeURIComponent(msg)}&apikey=${encodeURIComponent(key)}`, { signal: ctl.signal });
    if (!r.ok) console.error("callmebot", r.status, (await r.text()).slice(0, 200));
  } finally { clearTimeout(t); }
}

/* ---------------- Pedido do cliente ---------------- */
async function criarPedido(b: any) {
  const cfg = await lerConfig();
  const forma = String(b.forma || "");
  if (!["Pix", "Cartão", "Crediário próprio"].includes(forma)) throw new HttpErro(400, "Escolha a forma de pagamento.");

  // Produto e preço vêm do banco, nunca do navegador.
  let produto: any = null, preco = 0, produtoNome = "", categoria = "Outro", condicao = "";
  if (b.produtoId) {
    produto = (await q("SELECT * FROM wolfs_produtos WHERE id = $1 AND ativo", [Number(b.produtoId)]))[0];
    if (!produto) throw new HttpErro(404, "Esse produto não está mais disponível. Escolha outro.");
    preco = produto.preco_centavos; produtoNome = produto.nome; categoria = produto.categoria; condicao = produto.condicao;
  } else {
    if (forma !== "Crediário próprio" || !cfg.valorLivre) throw new HttpErro(400, "Escolha um produto.");
    preco = centavos(b.valor);
    if (!(preco >= 10000 && preco <= 5000000)) throw new HttpErro(400, "Digite um valor entre R$ 100 e R$ 50.000.");
    produtoNome = texto(b.descricaoLivre, 80) || "Compra no valor informado"; condicao = "A combinar";
  }

  const nome = texto(b.nome, 120), telefone = soDigitos(b.telefone).slice(-11);
  if (nome.split(/\s+/).length < 2) throw new HttpErro(400, "Coloque seu nome completo.");
  if (telefone.length < 10) throw new HttpErro(400, "Coloque seu telefone com DDD.");

  const p: Record<string, unknown> = {
    codigo: codigoPedido(), produto_id: produto ? produto.id : null, produto_nome: produtoNome, categoria, condicao,
    preco_centavos: preco, nome, telefone, cidade: texto(b.cidade, 80) || null,
  };

  if (forma === "Pix") {
    Object.assign(p, { forma: "Pix", parcelas: 1, total_centavos: preco, valor_parcela_centavos: preco });
  } else if (forma === "Cartão") {
    const n = Math.round(Number(b.parcelas) || 1);
    if (n < 1 || n > cfg.cartaoMax) throw new HttpErro(400, `Escolha de 1 a ${cfg.cartaoMax} parcelas.`);
    const taxa = Number(cfg.taxasCartao[String(n)] ?? 0);
    const total = Math.round(preco / (1 - taxa / 100));
    Object.assign(p, { forma: n > 1 ? "Crédito parcelado" : "Crédito à vista", parcelas: n, taxa_cartao: taxa, total_centavos: total, valor_parcela_centavos: Math.round(total / n) });
  } else {
    const cpf = soDigitos(b.cpf);
    if (!cpfValido(cpf)) throw new HttpErro(400, "CPF inválido. Confira os 11 números.");
    const cep = soDigitos(b.cep);
    if (cep.length !== 8) throw new HttpErro(400, "CEP precisa ter 8 números.");
    const rua = texto(b.rua, 120), numero = texto(b.numero, 20), bairro = texto(b.bairro, 80), cidade = texto(b.cidade, 80), uf = texto(b.uf, 2).toUpperCase();
    if (!rua || !numero || !bairro || !cidade || !/^[A-Z]{2}$/.test(uf)) throw new HttpErro(400, "Preencha o endereço completo (rua, número, bairro, cidade e UF).");
    const en = texto(b.emergNome, 120), ep = texto(b.emergParentesco, 40), et = soDigitos(b.emergTel).slice(-11);
    if (en.split(/\s+/).length < 2 || !ep || et.length < 10) throw new HttpErro(400, "Preencha o contato de emergência (nome completo, parentesco e telefone).");
    if (et === telefone) throw new HttpErro(400, "O contato de emergência precisa ter outro telefone, diferente do seu.");

    const n = Math.round(Number(b.parcelas) || 0);
    if (n < 2 || n > cfg.credMax) throw new HttpErro(400, `Escolha de 2 a ${cfg.credMax} parcelas.`);
    const pct = Number(b.entradaPct);
    if (!(pct >= cfg.entradaMin && pct <= 90)) throw new HttpErro(400, `A entrada mínima é de ${cfg.entradaMin}%.`);
    const dia = Math.round(Number(b.dia));
    if (!cfg.diasVencimento.includes(dia)) throw new HttpErro(400, "Escolha o dia do vencimento.");
    const entrada = Math.ceil(preco * pct / 100);
    const juros = Math.min(cfg.jurosMes, 1);
    const parcela = Math.round(parcelaPrice(preco - entrada, n, juros));
    Object.assign(p, {
      forma: "Crediário próprio", parcelas: n, entrada_centavos: entrada, juros_mes: juros, valor_parcela_centavos: parcela,
      total_centavos: entrada + parcela * n, dia_vencimento: dia, primeiro_venc: primeiroVencimento(dia),
      cpf: cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4"), cep: cep.replace(/(\d{5})(\d{3})/, "$1-$2"),
      rua, numero, complemento: texto(b.complemento, 60) || null, bairro, cidade, uf,
      emerg_nome: en, emerg_parentesco: ep, emerg_tel: et,
    });
  }
  const cols = Object.keys(p);
  const row = (await q(`INSERT INTO wolfs_pedidos (${cols.join(",")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(",")}) RETURNING *`, cols.map((k) => p[k])))[0];
  const ped = pedidoAdmin(row);
  const aviso = avisarDono(cfg, ped).catch((e) => console.error("aviso whatsapp", e));
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(aviso); else await aviso;
  return { codigo: ped.codigo, forma: ped.forma, produtoNome: ped.produtoNome, preco: ped.preco, entrada: ped.entrada, parcelas: ped.parcelas, valorParcela: ped.valorParcela, total: ped.total, jurosMes: ped.jurosMes, primeiroVenc: ped.primeiroVenc, diaVencimento: ped.diaVencimento };
}

/* ---------------- Acesso do administrador ---------------- */
function senhaAdmin() {
  const s = Deno.env.get("WOLFS_SENHA") || "";
  if (s.length < 6) throw new HttpErro(503, "Defina a senha do painel (segredo WOLFS_SENHA) no Supabase.");
  return s;
}
const chaveAssinatura = () => (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "") + "|" + senhaAdmin();
const assinar = (exp: number) => createHmac("sha256", chaveAssinatura()).update(`wolfs.${exp}`).digest("hex");
function igual(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function exigirAdmin(req: Request) {
  const [expStr, sig] = (req.headers.get("x-admin-token") || "").split(".");
  const exp = Number(expStr);
  if (!exp || !sig || exp < Date.now()) throw new HttpErro(401, "Sessão expirada. Entre de novo.");
  if (!igual(assinar(exp), sig)) throw new HttpErro(401, "Sessão inválida. Entre de novo.");
}
const tentativas = new Map<string, { n: number; ate: number }>();
function limitarLogin(ip: string) {
  const agora = Date.now(), t = tentativas.get(ip);
  if (t && t.ate > agora && t.n >= 8) throw new HttpErro(429, "Muitas tentativas. Espere 15 minutos.");
  if (!t || t.ate < agora) tentativas.set(ip, { n: 1, ate: agora + 15 * 60 * 1000 }); else t.n++;
}

const pedidosPorIp = new Map<string, { n: number; ate: number }>();
function limitarPedidos(ip: string) {
  const agora = Date.now(), t = pedidosPorIp.get(ip);
  if (t && t.ate > agora && t.n >= 10) throw new HttpErro(429, "Muitos pedidos seguidos. Tente de novo em 1 hora ou chame no WhatsApp.");
  if (!t || t.ate < agora) pedidosPorIp.set(ip, { n: 1, ate: agora + 3600 * 1000 }); else t.n++;
}

function limparProduto(b: any, novo: boolean) {
  const out: Record<string, unknown> = {};
  if (novo || "nome" in b) { out.nome = texto(b.nome, 120); if (!out.nome) throw new HttpErro(400, "Coloque o nome do produto."); }
  if (novo || "categoria" in b) out.categoria = texto(b.categoria, 40) || "Outro";
  if (novo || "condicao" in b) out.condicao = ["Novo", "Seminovo", "Usado"].includes(b.condicao) ? b.condicao : "Novo";
  if (novo || "preco" in b) { out.preco_centavos = centavos(b.preco); if (!((out.preco_centavos as number) > 0)) throw new HttpErro(400, "Coloque o preço à vista."); }
  if ("descricao" in b) out.descricao = texto(b.descricao, 300) || null;
  if ("imagem" in b) out.imagem = b.imagem ? texto(b.imagem, 100) : null;
  if ("ativo" in b) out.ativo = !!b.ativo;
  if ("ordem" in b) out.ordem = Math.round(Number(b.ordem) || 0);
  return out;
}

/* ---------------- Rotas ---------------- */
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const partes = url.pathname.replace(/^.*?\/wolfs(\/|$)/, "").split("/").filter(Boolean);
  const m = req.method;
  const corpo = async () => { try { return await req.json(); } catch { return {}; } };
  try {
    /* público */
    if (m === "GET" && partes[0] === "loja") {
      const [cfg, prods] = await Promise.all([lerConfig(), q("SELECT * FROM wolfs_produtos WHERE ativo ORDER BY ordem, id")]);
      return json({ config: configPublica(cfg), produtos: prods.map(produtoPublico) });
    }
    if (m === "POST" && partes[0] === "pedidos") {
      limitarPedidos((req.headers.get("x-forwarded-for") || "?").split(",")[0].trim());
      return json(await criarPedido(await corpo()), 201);
    }
    if (m === "GET" && partes[0] === "imagem" && partes[1]) {
      const r = (await q("SELECT tipo, encode(dados, 'base64') AS b64 FROM wolfs_imagens WHERE chave = $1", [partes[1]]))[0];
      if (!r) return new Response("Imagem não encontrada", { status: 404, headers: CORS });
      return new Response(Buffer.from(r.b64.replace(/\s/g, ""), "base64"), { headers: { ...CORS, "content-type": r.tipo, "cache-control": "public, max-age=31536000, immutable" } });
    }

    /* administrador */
    if (partes[0] === "admin") {
      if (m === "POST" && partes[1] === "login") {
        limitarLogin((req.headers.get("x-forwarded-for") || "?").split(",")[0].trim());
        const { senha } = await corpo();
        if (!igual(senhaAdmin(), String(senha || ""))) return erro("Senha incorreta.", 401);
        const exp = Date.now() + 12 * 3600 * 1000;
        return json({ token: `${exp}.${assinar(exp)}` });
      }
      exigirAdmin(req);

      /* painel de controle: estoque, clientes, vendas, preços de mercado e configuração */
      if (m === "GET" && partes[1] === "docs") {
        const rows = await q("SELECT colecao, id, dados FROM wolfs_docs ORDER BY colecao, id");
        return json({ agora: new Date().toISOString(), docs: rows });
      }
      if (partes[1] === "docs" && COLECOES.includes(partes[2])) {
        const col = partes[2];
        if (m === "POST" && !partes[3]) {
          const id = randomBytes(10).toString("hex");
          await q("INSERT INTO wolfs_docs (colecao, id, dados) VALUES ($1, $2, $3::jsonb)", [col, id, JSON.stringify(await corpo())]);
          return json({ id }, 201);
        }
        const id = texto(partes[3], 100);
        if (!/^[A-Za-z0-9_-]+$/.test(id)) return erro("Documento inválido.");
        if (m === "PUT") {
          await q("INSERT INTO wolfs_docs (colecao, id, dados) VALUES ($1, $2, $3::jsonb) ON CONFLICT (colecao, id) DO UPDATE SET dados = EXCLUDED.dados, atualizado_em = now()", [col, id, JSON.stringify(await corpo())]);
          return json({ ok: true });
        }
        if (m === "PATCH") {
          await q("INSERT INTO wolfs_docs (colecao, id, dados) VALUES ($1, $2, $3::jsonb) ON CONFLICT (colecao, id) DO UPDATE SET dados = wolfs_docs.dados || EXCLUDED.dados, atualizado_em = now()", [col, id, JSON.stringify(await corpo())]);
          return json({ ok: true });
        }
        if (m === "DELETE") {
          await q("DELETE FROM wolfs_docs WHERE colecao = $1 AND id = $2", [col, id]);
          return json({ ok: true });
        }
      }

      if (m === "GET" && partes[1] === "resumo") {
        const [cfg, prods, peds] = await Promise.all([
          lerConfig(),
          q("SELECT * FROM wolfs_produtos ORDER BY ordem, id"),
          q("SELECT * FROM wolfs_pedidos ORDER BY criado_em DESC LIMIT 500"),
        ]);
        return json({ config: configPublica(cfg), produtos: prods.map(produtoPublico), pedidos: peds.map(pedidoAdmin) });
      }
      if (m === "PUT" && partes[1] === "config") {
        const novo = limparConfig(await corpo());
        await q("UPDATE wolfs_config SET dados = dados || $1::jsonb, atualizado_em = now() WHERE id = 1", [JSON.stringify(novo)]);
        return json({ config: configPublica(await lerConfig()) });
      }
      if (m === "POST" && partes[1] === "produtos") {
        const p = limparProduto(await corpo(), true);
        const cols = Object.keys(p);
        const r = (await q(`INSERT INTO wolfs_produtos (${cols.join(",")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(",")}) RETURNING *`, cols.map((k) => p[k])))[0];
        return json(produtoPublico(r), 201);
      }
      if (m === "PUT" && partes[1] === "produtos" && partes[2]) {
        const p = limparProduto(await corpo(), false);
        const cols = Object.keys(p);
        if (!cols.length) return erro("Nada para salvar.");
        const r = (await q(`UPDATE wolfs_produtos SET ${cols.map((k, i) => `${k} = $${i + 1}`).join(", ")}, atualizado_em = now() WHERE id = $${cols.length + 1} RETURNING *`, [...cols.map((k) => p[k]), Number(partes[2])]))[0];
        if (!r) return erro("Produto não encontrado.", 404);
        return json(produtoPublico(r));
      }
      if (m === "DELETE" && partes[1] === "produtos" && partes[2]) {
        await q("DELETE FROM wolfs_produtos WHERE id = $1", [Number(partes[2])]);
        return json({ ok: true });
      }
      if (m === "PUT" && partes[1] === "pedidos" && partes[2]) {
        const b = await corpo(); const sets: string[] = [], vals: unknown[] = [];
        if ("status" in b) { if (!["novo", "em_analise", "aprovado", "recusado", "concluido", "cancelado"].includes(b.status)) return erro("Status inválido."); vals.push(b.status); sets.push(`status = $${vals.length}`); }
        if ("obsAdmin" in b) { vals.push(texto(b.obsAdmin, 500)); sets.push(`obs_admin = $${vals.length}`); }
        if (!sets.length) return erro("Nada para salvar.");
        vals.push(Number(partes[2]));
        const r = (await q(`UPDATE wolfs_pedidos SET ${sets.join(", ")}, atualizado_em = now() WHERE id = $${vals.length} RETURNING *`, vals))[0];
        if (!r) return erro("Pedido não encontrado.", 404);
        return json(pedidoAdmin(r));
      }
      if (m === "DELETE" && partes[1] === "pedidos" && partes[2]) {
        await q("DELETE FROM wolfs_pedidos WHERE id = $1", [Number(partes[2])]);
        return json({ ok: true });
      }
      if (m === "POST" && partes[1] === "imagem") {
        const tipo = req.headers.get("content-type") || "";
        if (!/^image\/(jpeg|png|webp|gif|avif)$/.test(tipo)) return erro("Envie uma imagem JPG, PNG ou WEBP.");
        const dados = await req.arrayBuffer();
        if (dados.byteLength > 4 * 1024 * 1024) return erro("A imagem deve ter até 4 MB.");
        const chave = randomBytes(12).toString("hex");
        await q("INSERT INTO wolfs_imagens (chave, tipo, dados) VALUES ($1, $2, decode($3, 'base64'))", [chave, tipo, Buffer.from(dados).toString("base64")]);
        return json({ imagem: chave, url: `${BASE}/imagem/${chave}` }, 201);
      }
    }
    return erro("Rota não encontrada.", 404);
  } catch (e) {
    if (e instanceof HttpErro) return erro(e.message, e.status);
    console.error(e);
    return erro("Erro no servidor. Tente de novo em instantes.", 500);
  }
});
