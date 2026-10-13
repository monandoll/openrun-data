// Trend pipeline. Two stages to stay under the 50-subrequest limit per invocation.
// Stage A: news -> candidate terms -> blog validation -> search-trend curves  (KV or:stage)
// Stage B: images + known sellers per item -> final list                       (KV or:data)

export const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
export const nos = (s) => strip(s).toLowerCase().replace(/[\s\-_.·,()\[\]'"!?~&]/g, '');

const HUB = 'https://naverapihub.apigw.ntruss.com';
const hdr = (env) => ({ 'X-NCP-APIGW-API-KEY-ID': env.NAVER_SEARCH_ID, 'X-NCP-APIGW-API-KEY': env.NAVER_SEARCH_SECRET });

export async function ns(env, kind, query, display, sort = 'sim', extra = {}) {
  const u = new URL(`${HUB}/search/v1/${kind}`);
  u.searchParams.set('query', query); u.searchParams.set('display', display); u.searchParams.set('sort', sort);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: hdr(env) });
  if (!r.ok) throw new Error(`naver ${kind} ${r.status}`);
  return r.json();
}

const SEEDS = [['오픈런 디저트', 'date'], ['웨이팅 대란', 'date'], ['품절 대란', 'date'], ['디저트 열풍', 'date'], ['오픈런', 'date'], ['떡픈런', 'date'], ['편의점 디저트 품절', 'date'], ['줄서서 먹는', 'date'], ['디저트 유행', 'date'], ['요즘 유행 간식', 'date'], ['오픈런 디저트', 'sim'], ['새벽 웨이팅 디저트', 'sim'], ['품절 대란 디저트', 'sim'], ['MZ 디저트 열풍', 'sim']];
const BLOCK = new Set(['오픈런', '떡픈런', '빵픈런', '품절 대란', '품절대란', '웨이팅', '웨이팅 대란', '인증샷', '떡지순례', '빵지순례', '맛꾸', '말먹', '얼먹', '뼈말라', '할매니얼', '디저트 열풍', '종합대책', '오늘의 브랜드', '오픈런 원조', '김밥', '디저트', '찹쌀떡', '과일찹쌀떡', '모찌', '떡', '빵', '쿠키', '편의점', '줄서기', '대리구매', '리셀', '먹방', '초콜릿 모찌', '요거트 찹쌀떡', '과일 찹쌀떡', '디토소비', '노티드', '피스타치오', 'K-디저트', 'K디저트', 'K-푸드', 'K푸드', '신상', '인기', '품절', '상품', '요즘', '가전', '뷰티', '떡 열풍', '디저트 대란', '쫀득 디저트']);
const BAD = /\d+\s*(시|건|분|만|개|일|년|월|차|위|%)|했다|한다|라인업|대책|브랜드|유튜버|회장|대표|장관|의원|정부|선거|경기|시즌|팬|공연|콘서트|축제|이벤트|할인|세일|쿠폰|다음은|다음|이어|열풍|대란|돌풍|신드롬|·|…|\.\.|\?|!/;
const FOOD = /맛|먹|디저트|떡|빵|쫀득|쫀쫀|달콤|달달|식감|간식|쿠키|케이크|모찌|찹쌀|크림|초코|초콜릿|아이스크림|젤라또|베이커리|카페|음료|라떼|과자|편의점|웨이팅|오픈런/g;
const DEMAND = /오픈런|웨이팅|품절|줄\s?서|줄을|대란|품귀|완판|매진|구하기|새벽|대기|난리|열풍|인기 폭발|불티/;
const RUN = /오픈런|웨이팅|대기|줄\s?서|줄을|번호표|품절|마감|매진|새벽/;
const CONV = ['GS25', 'CU', '세븐일레븐', '이마트24'];
const PRICE = /(\d{1,2},\d{3}|\d{4,5})\s?원/g;

function cleanTerm(raw) {
  let t = raw.replace(/\s+/g, ' ').trim();
  let alias = null;
  const m = t.match(/^(.+?)\s*\((.+?)\)$/);
  if (m) {
    const a = m[1].trim(), b = m[2].trim();
    if (/[+]/.test(b)) t = a; // "떡픈런(떡+오픈런)"
    else if (/^[가-힣A-Za-z0-9 ]{2,7}$/.test(b) && b.length < a.length) { t = b; alias = a; }
    else { t = a; alias = b; }
  }
  if (t.length < 2 || t.length > 14 || !/[가-힣]/.test(t)) return null;
  if (BAD.test(t) || BLOCK.has(t) || BLOCK.has(t.replace(/\s/g, ''))) return null;
  return { t, alias };
}

function prices(txts) {
  const c = new Map();
  for (const s of txts) for (const m of s.matchAll(PRICE)) { const v = Number(m[1].replace(/,/g, '')); if (v >= 1000 && v <= 60000 && v % 100 === 0) c.set(v, (c.get(v) || 0) + 1); }
  const top = [...c.entries()].sort((a, b) => b[1] - a[1]);
  return top.length && top[0][1] >= 2 ? top[0][0] : null;
}

const ymd = (d) => d.toISOString().slice(0, 10);

export async function stageA(env) {
  const prev = JSON.parse((await env.KV.get('or:data')) || '{"items":[]}');
  const cfg = JSON.parse((await env.KV.get('or:cfg')) || '{"block":[],"pin":[]}');
  const block = new Set((cfg.block || []).map(nos));
  const now = Date.now();
  // 1) news
  const arts = new Map();
  const res = await Promise.all(SEEDS.map(([q, so]) => ns(env, 'news', q, 100, so).catch(() => null)));
  for (const j of res) for (const it of j?.items || []) {
    const t = Date.parse(it.pubDate); if (!t || now - t > 14 * 864e5) continue;
    const key = it.originallink || it.link; if (arts.has(key)) continue;
    let src = ''; try { src = new URL(it.originallink || it.link).hostname.replace(/^www\d?\./, ''); } catch {}
    arts.set(key, { t: strip(it.title), s: strip(it.description), l: it.originallink || it.link, d: t, src });
  }
  // 2) candidate terms from quoted phrases
  const cand = new Map(); // nospace -> {t, aliases:Set, n, arts:Set}
  const add = (t, alias, a) => {
    const k = nos(t); if (block.has(k)) return;
    let c = cand.get(k); if (!c) cand.set(k, (c = { t, aliases: new Set(), n: 0, arts: new Set() }));
    if (alias) c.aliases.add(alias);
    if (!c.arts.has(a.l)) { c.arts.add(a.l); c.n++; }
  };
  for (const a of arts.values()) {
    const txt = a.t + ' ' + a.s;
    for (const m of txt.matchAll(/[‘'"“]([^’'"”]{2,24})[’'"”]/g)) { const c = cleanTerm(m[1]); if (c) add(c.t, c.alias, a); }
  }
  // known items keep being tracked even if quotes disappear
  const known = [...(prev.items || []).slice(0, 12).map((x) => x.name), ...(cfg.pin || [])];
  for (const name of known) { const k = nos(name); if (block.has(k)) continue; if (!cand.has(k)) cand.set(k, { t: name, aliases: new Set(), n: 0, arts: new Set() }); cand.get(k).known = true; }
  for (const a of arts.values()) { const txt = nos(a.t + ' ' + a.s); for (const c of cand.values()) if (!c.arts.has(a.l) && nos(c.t).length >= 2 && txt.includes(nos(c.t))) { c.arts.add(a.l); c.n++; } }
  // 2b) alias merge: "두바이 쫀득 쿠키" is an alias of "두쫀쿠"
  for (const c of cand.values()) for (const al of c.aliases) { const o = cand.get(nos(al)); if (o && o !== c && !o.merged) { o.merged = true; for (const x of o.arts) c.arts.add(x); c.n = c.arts.size; } }
  // 3) merge variants: "한정선 요거트 찹쌀떡" -> "한정선"
  const list = [...cand.values()].filter((c) => !c.merged).sort((a, b) => a.t.length - b.t.length);
  for (const c of list) {
    if (c.merged) continue;
    for (const p of list) {
      if (p === c || p.merged || p.t.length >= c.t.length || nos(p.t).length < 2) continue;
      if (c.t.startsWith(p.t + ' ') || (nos(c.t).startsWith(nos(p.t)) && nos(p.t).length >= 3)) {
        c.merged = true; p.variants = p.variants || new Set(); p.variants.add(c.t); for (const x of c.arts) p.arts.add(x); p.n = p.arts.size; break;
      }
    }
  }
  let pool = list.filter((c) => !c.merged && (c.n >= 2 || c.known)).sort((a, b) => (b.known - a.known) || (b.n - a.n)).slice(0, 28);
  // 4) blog validation (sorted by date)
  const vals = await Promise.all(pool.map((c) => ns(env, 'blog', c.t, 100, 'date').catch(() => null)));
  const ok = [];
  pool.forEach((c, i) => {
    const j = vals[i]; if (!j) return;
    const k = nos(c.t); const keys = [k, ...[...c.aliases].map(nos)];
    const items = j.items || [];
    const hits = items.filter((it) => { const x = nos(it.title + it.description); return keys.some((q) => x.includes(q)); });
    const food = hits.filter((it) => ((it.title + ' ' + it.description).match(FOOD) || []).length >= 2);
    const pinned = (cfg.pin || []).map(nos).includes(k);
    if (!pinned && (hits.length < 15 || food.length / Math.max(1, hits.length) < 0.5)) return;
    // velocity: posts per week mentioning it (estimate from the newest 100)
    const dates = items.map((it) => Date.UTC(+it.postdate.slice(0, 4), +it.postdate.slice(4, 6) - 1, +it.postdate.slice(6, 8)));
    const span = dates.length ? Math.max(1, (now - Math.min(...dates)) / 864e5) : 30;
    const toT = (pd) => Date.UTC(+pd.slice(0, 4), +pd.slice(4, 6) - 1, +pd.slice(6, 8));
    const week = span >= 7 ? hits.filter((it) => now - toT(it.postdate) <= 7 * 864e5).length : Math.round(hits.length * 7 / span);
    const posts = hits.slice(0, 40).map((it) => ({ t: strip(it.title), s: strip(it.description).slice(0, 110), l: it.link, d: it.postdate, b: strip(it.bloggername), run: RUN.test(strip(it.title + ' ' + it.description)) }));
    const txts = hits.map((it) => strip(it.title + ' ' + it.description));
    let conv = null; for (const b of CONV) { const n = txts.filter((s) => s.includes(b)).length; if (n / Math.max(1, txts.length) >= 0.25 && (!conv || n > conv.n)) conv = { b, n }; }
    const news = [...c.arts].map((l) => arts.get(l)).filter(Boolean).sort((a, b) => b.d - a.d).slice(0, 6).map((a) => ({ t: a.t, l: a.l, d: ymd(new Date(a.d)), src: a.src }));
    const demandNews = [...c.arts].map((l) => arts.get(l)).filter((a) => a && DEMAND.test(a.t + ' ' + a.s) && /오픈런|웨이팅|품절|줄|대란|품귀|완판|매진|새벽|대기|난리|불티/.test(a.t + ' ' + a.s)).length;
    const runPosts = posts.filter((x) => x.run).length;
    if (!pinned && demandNews < 2 && runPosts < 4) return;
    const novelty = j.total ? week / j.total : 0;
    const score = Math.round((c.n * 2 + week / 20) * (novelty < 0.002 ? 0.4 : 1 + Math.min(novelty * 20, 1)) * 10) / 10;
    ok.push({ score, novelty: Math.round(novelty * 1e4) / 1e4, name: c.t, aliases: [...c.aliases], variants: [...(c.variants || [])].slice(0, 6), newsN: c.n, week, posts, news, price: prices(txts), conv: conv?.b || null });
  });
  ok.sort((a, b) => b.score - a.score);
  const top = ok.slice(0, 12);
  // 5) search trend (daily, 42 days), 5 groups per call
  const end = new Date(now + 9 * 36e5); end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - 41);
  for (let i = 0; i < top.length; i += 5) {
    const g = top.slice(i, i + 5);
    try {
      const r = await fetch(`${HUB}/search-trend/v1/search`, { method: 'POST', headers: { ...hdr(env), 'Content-Type': 'application/json' }, body: JSON.stringify({ startDate: ymd(start), endDate: ymd(end), timeUnit: 'date', keywordGroups: g.map((x) => ({ groupName: x.name, keywords: [...new Set([x.name, x.name.replace(/\s/g, ''), ...x.aliases])].slice(0, 20) })) }) });
      const j = await r.json();
      for (const res2 of j.results || []) {
        const it = g.find((x) => x.name === res2.title); if (!it) continue;
        const byDay = new Map(res2.data.map((d) => [d.period, d.ratio]));
        const days = []; for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) days.push(byDay.get(ymd(d)) || 0);
        const weeks = []; for (let w = 0; w < 6; w++) weeks.push(days.slice(w * 7, w * 7 + 7).reduce((s, v) => s + v, 0));
        const mx = Math.max(...weeks, 1e-9);
        it.curve = weeks.map((v) => Math.round((v / mx) * 100));
        const last = weeks[5], prv = weeks[4];
        it.growth = prv > 0 ? Math.round((last / prv) * 10) / 10 : last > 0 ? 9.9 : null;
      }
    } catch {}
  }
  const stage = { t: now, items: top, cands: pool.map((c) => [c.t, c.n]).slice(0, 28), rejected: pool.filter((c) => !top.find((x) => x.name === c.t)).map((c) => c.t) };
  await env.KV.put('or:stage', JSON.stringify(stage));
  return { arts: arts.size, cands: pool.length, accepted: ok.length, top: top.map((x) => `${x.name} s${x.score} w${x.week} n${x.newsN} nov${x.novelty} g${x.growth}`) };
}

const GENERIC = /^(모찌|떡|쿠키|빵|케이크|디저트|찹쌀떡|절편|설기|소금빵|젤라또|아이스크림|크림|초코|초콜릿|라떼)$/;
const NOT_SELLER = /떡볶이|분식|한식|육류|고기|술집|주점|호프|치킨|피자|중식|일식|양식|국밥|찌개/;
const SELLER_CAT = /카페|디저트|떡|베이커리|제과|빵|초콜릿|아이스크림|케이크|도넛|와플|편의점|과자|음료/;

export async function stageB(env) {
  const st = JSON.parse((await env.KV.get('or:stage')) || 'null');
  if (!st) return { err: 'no stage' };
  const prev = JSON.parse((await env.KV.get('or:data')) || '{"items":[]}');
  const prevMap = new Map((prev.items || []).map((x, i) => [x.name, { ...x, rank: i + 1 }]));
  const out = await Promise.all(st.items.map(async (it, i) => {
    const [ij, lj] = await Promise.all([ns(env, 'image', it.name, 60, 'date').catch(() => null), ns(env, 'local', it.name, 5, 'random').catch(() => null)]);
    const keys = [nos(it.name), ...it.aliases.map(nos)];
    const imgs = [];
    const toks = it.name.split(/\s+/).map(nos).filter((t) => t.length >= 2);
    const tokHit = (t) => toks.length > 1 && toks.every((k) => nos(t).includes(k));
    for (const x of ij?.items || []) { if (!keys.some((k) => nos(x.title).includes(k)) && !tokHit(x.title)) continue; imgs.push({ th: x.thumbnail, l: x.link }); if (imgs.length >= 8) break; }
    const places = [];
    for (const p of lj?.items || []) {
      const t = strip(p.title), cat = p.category || '';
      if (!(SELLER_CAT.test(cat) || keys.some((k) => nos(t).includes(k)))) continue;
      if (NOT_SELLER.test(cat) && !keys.some((k) => nos(t).includes(k))) continue;
      places.push({ t, cat: cat.split('>').pop(), a: p.roadAddress || p.address, lat: Number(p.mapy) / 1e7, lng: Number(p.mapx) / 1e7 });
    }
    const brand = toks.length > 1 ? toks.filter((t) => !GENERIC.test(t)) : [];
    const branded = places.filter((pl) => brand.some((b) => nos(pl.t).includes(b)));
    if (branded.length) places.splice(0, places.length, ...branded);
    const txt = [...it.posts.map((x) => x.t + ' ' + x.s), ...it.news.map((x) => x.t)].join(' ');
    const onlyHits = (txt.match(/에서만|단독\s?판매|한정\s?판매|1호점|한 곳/g) || []).length;
    const only = !it.conv && places.length === 1 && onlyHits >= 1;
    const p = prevMap.get(it.name);
    return { ...it, posts: it.posts.slice(0, 20), only, id: nos(it.name), imgs, places, first: p?.first || ymd(new Date(st.t + 9 * 36e5)), prevRank: p?.rank || null };
  }));
  const data = { u: st.t, items: out };
  await env.KV.put('or:data', JSON.stringify(data));
  return { items: out.map((x) => `${x.name} img${x.imgs.length} pl${x.places.length}`) };
}

// nearby sellers: "<area> <menu>" (or "<area> GS25" for convenience-store items)
export async function near(env, p) {
  const q = (p.get('q') || '').trim().slice(0, 30), a = (p.get('a') || '').trim().slice(0, 12), conv = (p.get('conv') || '').trim();
  const lat = Number(p.get('lat') || 0), lng = Number(p.get('lng') || 0);
  if (!q || !a) return { items: [] };
  const queries = conv ? [`${a} ${conv}`] : [`${a} ${q}`];
  const k = nos(q);
  const seen = new Set(), items = [];
  for (const qq of queries) {
    const j = await ns(env, 'local', qq, 5, 'random');
    for (const x of j.items || []) {
      const t = strip(x.title), cat = x.category || '';
      if (conv ? !t.includes(conv) : !(SELLER_CAT.test(cat) || nos(t).includes(k))) continue;
      if (!conv && NOT_SELLER.test(cat) && !nos(t).includes(k)) continue;
      const plat = Number(x.mapy) / 1e7, plng = Number(x.mapx) / 1e7;
      const dist = lat ? Math.round(Math.hypot((plat - lat) * 111000, (plng - lng) * 88000)) : null;
      if (dist != null && dist > 15000) continue;
      if (seen.has(t)) continue; seen.add(t);
      items.push({ t, cat: cat.split('>').pop(), a: x.roadAddress || x.address, lat: plat, lng: plng, named: nos(t).includes(k) });
    }
  }
  return { items, q: queries[0] };
}
