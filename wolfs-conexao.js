// Liga o painel de controle da Wolfs ao servidor (Supabase, função "wolfs").
// Faz o papel do banco de dados, das fotos e dos downloads que o painel usava dentro do Claude.
(() => {
  const API = "https://ccgnncfjqvbvxutdnmja.supabase.co/functions/v1/wolfs/";
  const CHAVE = "wolfs-token";
  let token = "";
  try { token = sessionStorage.getItem(CHAVE) || localStorage.getItem(CHAVE) || ""; } catch {}
  const guardar = (t) => { token = t; try { sessionStorage.setItem(CHAVE, t); localStorage.setItem(CHAVE, t); } catch {} };
  const esquecer = () => { token = ""; try { sessionStorage.removeItem(CHAVE); localStorage.removeItem(CHAVE); } catch {} };

  async function chamar(caminho, opts = {}) {
    const r = await fetch(API + caminho, { ...opts, headers: { "content-type": "application/json", "x-admin-token": token, ...(opts.headers || {}) } });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401) { esquecer(); mostrarLogin(d.erro || "Sua sessão expirou. Entre de novo."); throw Object.assign(new Error(d.erro || "Entre de novo."), { code: "unauthenticated" }); }
    if (!r.ok) throw Object.assign(new Error(d.erro || "Não foi possível salvar agora."), { code: "unavailable" });
    return d;
  }

  /* ---------- Tela de entrada ---------- */
  let liberar;
  const entrou = new Promise((ok) => { liberar = ok; });
  function telaLogin() {
    const css = document.createElement("style");
    css.textContent = `
      .wl-login { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; padding: 20px; background: rgba(5,5,7,.55); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
      .wl-card { width: min(400px, 100%); background: rgba(14,14,17,.92); border: 1px solid rgba(255,255,255,.12); border-radius: 18px; padding: 24px; display: grid; gap: 14px; color: #f3f3f4; font-family: "Plus Jakarta Sans", system-ui, sans-serif; box-shadow: 0 30px 80px -30px rgba(0,0,0,.8); }
      .wl-card .wl-top { display: flex; gap: 12px; align-items: center; }
      .wl-card img { width: 64px; height: 44px; object-fit: cover; border-radius: 10px; box-shadow: 0 0 0 1px rgba(255,59,59,.4); }
      .wl-card h2 { margin: 0; font-family: Sora, system-ui, sans-serif; font-size: 1.15rem; }
      .wl-card p { margin: 0; color: #a2a3a8; font-size: .86rem; }
      .wl-card label { display: grid; gap: 6px; font-size: .78rem; color: #a2a3a8; font-weight: 600; }
      .wl-card input { font: inherit; font-size: .95rem; color: #f3f3f4; background: rgba(0,0,0,.5); border: 1px solid rgba(255,255,255,.14); border-radius: 10px; padding: 11px 12px; }
      .wl-card button { border: 0; border-radius: 12px; padding: 12px 16px; font: inherit; font-weight: 700; color: #fff; background: linear-gradient(180deg, #ff4b4b, #d61f1f); cursor: pointer; }
      .wl-card .wl-err { color: #ff6b63; font-size: .84rem; }`;
    document.head.append(css);
    const box = document.createElement("div");
    box.className = "wl-login"; box.hidden = true;
    box.innerHTML = `<form class="wl-card" novalidate>
      <div class="wl-top"><img src="fotos/logo.jpg" alt=""><div><h2>Painel Wolfs</h2><p>Área só do administrador</p></div></div>
      <label>Senha<input type="password" autocomplete="current-password"></label>
      <p class="wl-err" hidden></p>
      <button type="submit">Entrar</button>
    </form>`;
    document.body.append(box);
    const form = box.querySelector("form"), inp = box.querySelector("input"), err = box.querySelector(".wl-err");
    form.addEventListener("submit", async (e) => {
      e.preventDefault(); err.hidden = true;
      try {
        const r = await fetch(API + "admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ senha: inp.value }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.erro || "Senha incorreta.");
        guardar(d.token); inp.value = ""; box.hidden = true; liberar(); recarregar();
      } catch (x) { err.textContent = x.message; err.hidden = false; }
    });
    return { box, inp, err };
  }
  let login;
  function mostrarLogin(msg) {
    if (!login) login = telaLogin();
    login.box.hidden = false;
    if (msg) { login.err.textContent = msg; login.err.hidden = false; }
    setTimeout(() => login.inp.focus(), 50);
  }
  window.wolfsSair = () => { esquecer(); location.reload(); };

  /* ---------- Banco de dados ---------- */
  const dados = { estoque: new Map(), clientes: new Map(), vendas: new Map(), mercado: new Map(), config: new Map() };
  const ouvintesCol = {}, ouvintesDoc = {};
  const avisar = (col) => {
    const docs = [...dados[col].entries()].map(([id, d]) => ({ id, data: () => d }));
    (ouvintesCol[col] || []).forEach((fn) => fn({ docs, docChanges: () => [] }));
    Object.entries(ouvintesDoc).forEach(([k, fns]) => { const [c, id] = k.split("/"); if (c === col) fns.forEach((fn) => fn({ id, exists: dados[col].has(id), data: () => dados[col].get(id) })); });
  };
  let carregado = false;
  async function recarregar() {
    if (!token) return;
    try {
      const r = await chamar("admin/docs");
      Object.values(dados).forEach((m) => m.clear());
      for (const d of r.docs || []) if (dados[d.colecao]) dados[d.colecao].set(d.id, d.dados || {});
      carregado = true;
      Object.keys(dados).forEach(avisar);
    } catch { /* tela de entrada ou rede: tenta de novo no próximo ciclo */ }
  }
  setInterval(() => { if (document.visibilityState === "visible") recarregar(); }, 20000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") recarregar(); });

  const limpo = (o) => JSON.parse(JSON.stringify(o ?? {}));
  function docRef(col, id) {
    return {
      id, path: col + "/" + id,
      async set(d) { const v = limpo(d); await chamar(`admin/docs/${col}/${id}`, { method: "PUT", body: JSON.stringify(v) }); dados[col].set(id, v); avisar(col); },
      async update(d) { const v = limpo(d); await chamar(`admin/docs/${col}/${id}`, { method: "PATCH", body: JSON.stringify(v) }); dados[col].set(id, { ...(dados[col].get(id) || {}), ...v }); avisar(col); },
      async delete() { await chamar(`admin/docs/${col}/${id}`, { method: "DELETE" }); dados[col].delete(id); avisar(col); },
      async get() { return { id, exists: dados[col].has(id), data: () => dados[col].get(id) }; },
      onSnapshot(next) { const k = col + "/" + id; (ouvintesDoc[k] = ouvintesDoc[k] || []).push(next); if (carregado) next({ id, exists: dados[col].has(id), data: () => dados[col].get(id) }); return () => { ouvintesDoc[k] = ouvintesDoc[k].filter((f) => f !== next); }; },
    };
  }
  function colRef(col) {
    if (!dados[col]) throw new TypeError("Coleção desconhecida: " + col);
    return {
      path: col,
      doc(id) { return docRef(col, id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 10))); },
      async add(d) { const v = limpo(d); const r = await chamar(`admin/docs/${col}`, { method: "POST", body: JSON.stringify(v) }); dados[col].set(r.id, v); avisar(col); return docRef(col, r.id); },
      async get() { return { docs: [...dados[col].entries()].map(([id, d]) => ({ id, data: () => d })) }; },
      onSnapshot(next) { (ouvintesCol[col] = ouvintesCol[col] || []).push(next); if (carregado) next({ docs: [...dados[col].entries()].map(([id, d]) => ({ id, data: () => d })), docChanges: () => [] }); return () => { ouvintesCol[col] = ouvintesCol[col].filter((f) => f !== next); }; },
    };
  }
  const db = { collection: colRef, doc: (p) => { const [c, id] = p.split("/"); return docRef(c, id); } };

  /* ---------- Fotos e downloads ---------- */
  const assets = {
    async upload(blob) {
      const r = await fetch(API + "admin/imagem", { method: "POST", headers: { "content-type": blob.type || "image/jpeg", "x-admin-token": token }, body: blob });
      const d = await r.json().catch(() => ({}));
      if (r.status === 401) { esquecer(); mostrarLogin("Sua sessão expirou. Entre de novo."); }
      if (!r.ok) throw Object.assign(new Error(d.erro || "Não foi possível enviar a foto."), { code: r.status === 400 ? "too_large" : "unavailable" });
      return { id: d.imagem, url: d.url, sizeBytes: blob.size, contentType: blob.type };
    },
  };
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    },
  };

  /* ---------- Pedidos do site (para o botão "Colar pedido do site") ---------- */
  window.wolfsPedidosSite = async () => (await chamar("admin/resumo")).pedidos || [];
  window.wolfsImagemUrl = (id) => id ? API + "imagem/" + id : null;

  window.claude = {
    use: async (nome) => {
      if (nome === "db") { await entrou; await recarregar(); return db; }
      if (nome === "assets") { await entrou; return assets; }
      if (nome === "downloads") return downloads;
      return null;
    },
  };

  const iniciar = () => { if (token) { liberar(); } else mostrarLogin(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciar); else iniciar();
})();
