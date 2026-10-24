'use strict';

const API = 'https://api.weather.gov';
const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
const REFRESH_MS = 10 * 60 * 1000;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- storage (best effort) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ---------- fetch helpers ----------
async function nws(path, tries = 2) {
  const url = path.startsWith('http') ? path : API + path;
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/geo+json' } });
      if (!res.ok) {
        let msg = `NWS returned ${res.status}`;
        try { const j = await res.json(); msg = j.detail || j.title || msg; } catch {}
        const err = new Error(msg); err.status = res.status; throw err;
      }
      return await res.json();
    } catch (err) {
      // The gridpoint forecast endpoints intermittently 500; one retry usually fixes it.
      if (i + 1 >= tries || (err.status && err.status < 500)) throw err;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
}

// ---------- unit conversion ----------
function qv(q) { return q && q.value != null ? q.value : null; }
function toF(q) {
  const v = qv(q); if (v == null) return null;
  return /degF$/.test(q.unitCode) ? v : v * 9 / 5 + 32;
}
function toMph(q) {
  const v = qv(q); if (v == null) return null;
  if (/m_s-1$/.test(q.unitCode)) return v * 2.23694;
  if (/km_h-1$/.test(q.unitCode)) return v / 1.609344;
  return v;
}
const paToInHg = (q) => (qv(q) == null ? null : q.value / 3386.389);
const mToMi = (q) => (qv(q) == null ? null : q.value / 1609.344);
function compass(deg) {
  if (deg == null) return '';
  return ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(deg / 22.5) % 16];
}
const round = (v) => (v == null ? '—' : Math.round(v));
function icon(url, size) {
  if (!url) return '';
  return url.replace(/size=\w+/, `size=${size}`);
}
function ago(iso) {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return `${h} hr ago`;
}
const fmtTime = (iso, opts) => new Date(iso).toLocaleString([], opts);

// ---------- state ----------
let place = store.get('place', null); // {lat, lon, name}
let saved = store.get('saved', []);
let refreshTimer = null;
let loading = false;
let lastLoad = 0;

function setStatus(msg, isError = false) {
  const el = $('#status');
  el.textContent = msg || '';
  el.classList.toggle('error', isError);
}

// ---------- main load ----------
async function load() {
  if (!place || loading) return;
  loading = true;
  lastLoad = Date.now();
  $('#refresh-btn').classList.add('spin');
  $('#loc-name').textContent = place.name || `${place.lat.toFixed(2)}, ${place.lon.toFixed(2)}`;
  setStatus('Loading forecast…');

  try {
    const lat = place.lat.toFixed(4), lon = place.lon.toFixed(4);
    const point = (await nws(`/points/${lat},${lon}`)).properties;

    if (!place.name && point.relativeLocation) {
      const r = point.relativeLocation.properties;
      place.name = `${r.city}, ${r.state}`;
      store.set('place', place);
      $('#loc-name').textContent = place.name;
    }

    const [forecast, hourly, alerts, obs] = await Promise.allSettled([
      nws(point.forecast),
      nws(point.forecastHourly),
      nws(`/alerts/active?point=${lat},${lon}`),
      latestObservation(point.observationStations),
    ]);

    const fc = forecast.status === 'fulfilled' ? forecast.value.properties : null;
    const hr = hourly.status === 'fulfilled' ? hourly.value.properties : null;

    renderAlerts(alerts.status === 'fulfilled' ? alerts.value.features : []);
    renderCurrent(obs.status === 'fulfilled' ? obs.value : null, fc, hr);
    if (hr) renderHourly(hr.periods);
    if (fc) renderDaily(fc.periods);
    renderRadar(place.lat, place.lon, point.radarStation);
    loadDiscussion(point.cwa);

    const failed = [forecast.status, hourly.status].filter((s) => s === 'rejected').length;
    setStatus(failed ? 'Some forecast data could not be loaded. Try refreshing.' : '', !!failed);
    $('#updated').textContent = fc ? ` · Forecast updated ${fmtTime(fc.updateTime || fc.generatedAt, { hour: 'numeric', minute: '2-digit', weekday: 'short' })}` : '';
  } catch (err) {
    const msg = err.status === 404
      ? 'The NWS has no forecast for this spot. It only covers the US and its territories.'
      : `Couldn't load weather: ${err.message}`;
    setStatus(msg, true);
  } finally {
    loading = false;
    $('#refresh-btn').classList.remove('spin');
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { if (!document.hidden) load(); }, REFRESH_MS);
  }
}

// Try the nearest few stations until one has a recent temperature reading.
async function latestObservation(stationsUrl) {
  const stations = (await nws(stationsUrl)).features.slice(0, 4);
  for (const st of stations) {
    try {
      const o = await nws(`${st.id}/observations/latest`, 1);
      const p = o.properties;
      const fresh = Date.now() - new Date(p.timestamp) < 3 * 3600 * 1000;
      if (p.temperature.value != null && fresh) return { ...p, stationName: st.properties.name };
    } catch {}
  }
  return null;
}

// ---------- renderers ----------
function renderAlerts(features) {
  const el = $('#alerts');
  if (!features.length) { el.hidden = true; el.innerHTML = ''; return; }
  const order = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };
  features.sort((a, b) => (order[a.properties.severity] ?? 5) - (order[b.properties.severity] ?? 5));
  el.innerHTML = features.map(({ properties: p }) => `
    <details class="alert ${esc(p.severity)}">
      <summary>
        <div class="ev">${esc(p.event)}</div>
        <div class="small muted">${p.ends || p.expires ? `Until ${esc(fmtTime(p.ends || p.expires, { weekday: 'short', hour: 'numeric', minute: '2-digit' }))} · ` : ''}${esc(p.senderName || '')}</div>
      </summary>
      <div class="body">${p.headline ? `<strong>${esc(p.headline)}</strong>\n` : ''}${esc(p.description)}${p.instruction ? `<h4>What to do</h4>${esc(p.instruction)}` : ''}</div>
    </details>`).join('');
  el.hidden = false;
}

function renderCurrent(o, fc, hr) {
  const el = $('#current');
  const first = fc?.periods?.[0];
  const nowHr = hr?.periods?.[0];
  const temp = o ? toF(o.temperature) : nowHr?.temperature;
  const feels = o ? (toF(o.heatIndex) ?? toF(o.windChill)) : null;
  const desc = o?.textDescription || nowHr?.shortForecast || '';
  const img = icon(o?.icon || nowHr?.icon, 'medium');

  // High/low for "today": the first daytime + nighttime periods.
  let hi = null, lo = null;
  for (const p of (fc?.periods || []).slice(0, 2)) { if (p.isDaytime) hi = p.temperature; else lo = p.temperature; }

  const stats = [];
  if (o) {
    if (feels != null && Math.abs(feels - temp) >= 2) stats.push(['Feels like', `${round(feels)}°`]);
    const ws = toMph(o.windSpeed), wg = toMph(o.windGust);
    stats.push(['Wind', ws == null ? '—' : ws < 1 ? 'Calm' : `${compass(o.windDirection.value)} ${round(ws)} mph${wg ? `, gusts ${round(wg)}` : ''}`]);
    stats.push(['Humidity', o.relativeHumidity.value == null ? '—' : `${round(o.relativeHumidity.value)}%`]);
    stats.push(['Dew point', `${round(toF(o.dewpoint))}°`]);
    const pr = paToInHg(o.barometricPressure);
    stats.push(['Pressure', pr == null ? '—' : `${pr.toFixed(2)} in`]);
    const vis = mToMi(o.visibility);
    stats.push(['Visibility', vis == null ? '—' : `${vis >= 10 ? '10+' : vis.toFixed(1)} mi`]);
  } else if (nowHr) {
    stats.push(['Wind', `${nowHr.windDirection} ${nowHr.windSpeed}`]);
    if (nowHr.relativeHumidity) stats.push(['Humidity', `${nowHr.relativeHumidity.value}%`]);
  }

  el.innerHTML = `
    <div class="now">
      ${img ? `<img src="${esc(img)}" alt="">` : ''}
      <div>
        <div class="temp">${round(temp)}°</div>
        <div class="desc">${esc(desc)}</div>
        <div class="hilo">${hi != null ? `H ${hi}°` : ''}${hi != null && lo != null ? ' · ' : ''}${lo != null ? `L ${lo}°` : ''}</div>
      </div>
    </div>
    <dl class="stats">${stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
    <p class="muted small">${o ? `Observed at ${esc(o.stationName)} · ${ago(o.timestamp)}` : 'No recent station observation; showing the current hourly forecast.'}</p>
    ${first ? `<p class="today-text"><strong>${esc(first.name)}:</strong> ${esc(first.detailedForecast)}</p>` : ''}`;
  el.hidden = false;
}

function renderHourly(periods) {
  const now = Date.now();
  const list = periods.filter((p) => new Date(p.endTime) > now).slice(0, 48);
  $('#hourly').innerHTML = list.map((p, i) => {
    const d = new Date(p.startTime);
    const newDay = i > 0 && d.getHours() === 0;
    const label = i === 0 ? '<b>Now</b>' : newDay
      ? `<b>${d.toLocaleDateString([], { weekday: 'short' })}</b>`
      : d.toLocaleTimeString([], { hour: 'numeric' });
    const pop = p.probabilityOfPrecipitation?.value;
    return `<div class="hr${newDay ? ' daystart' : ''}" title="${esc(p.shortForecast)}">
      <div class="t">${label}</div>
      <img src="${esc(icon(p.icon, 'small'))}" alt="${esc(p.shortForecast)}" loading="lazy">
      <div class="deg">${p.temperature}°</div>
      <div class="pop">${pop ? `${pop}%` : ''}</div>
      <div class="w">${esc(p.windSpeed.replace(' mph', ''))} ${esc(p.windDirection)}</div>
    </div>`;
  }).join('');
  $('#hourly-card').hidden = false;
}

function renderDaily(periods) {
  const days = [];
  let cur = null;
  for (const p of periods) {
    if (p.isDaytime) { cur = { day: p, night: null }; days.push(cur); }
    else if (cur && !cur.night) cur.night = p;
    else { cur = { day: null, night: p }; days.push(cur); }
  }
  $('#daily').innerHTML = days.map(({ day, night }, i) => {
    const main = day || night;
    const pops = [day, night].map((p) => p?.probabilityOfPrecipitation?.value || 0);
    const pop = Math.max(...pops);
    const name = i === 0 ? (day ? 'Today' : night.name) : new Date(main.startTime).toLocaleDateString([], { weekday: 'short' });
    return `<details class="day">
      <summary>
        <span class="dn">${esc(name)}</span>
        <img src="${esc(icon(main.icon, 'small'))}" alt="" loading="lazy">
        <span class="sf">${esc(main.shortForecast)}${pop ? ` <span class="pop">${pop}%</span>` : ''}</span>
        <span class="hl">${day ? `${day.temperature}°` : ''}${night ? `<span class="lo">${night.temperature}°</span>` : ''}</span>
      </summary>
      <div class="detail">
        ${day ? `<p><strong>${esc(day.name)}:</strong> ${esc(day.detailedForecast)}</p>` : ''}
        ${night ? `<p><strong>${esc(night.name)}:</strong> ${esc(night.detailedForecast)}</p>` : ''}
      </div>
    </details>`;
  }).join('');
  $('#daily-card').hidden = false;
}

// ---------- radar ----------
// NEXRAD base reflectivity mosaic tiles (NWS data, served by Iowa Environmental Mesonet),
// one layer per 5-minute frame from 50 minutes ago to now.
const RADAR_OFFSETS = [50, 45, 40, 35, 30, 25, 20, 15, 10, 5, 0];
const radar = { map: null, marker: null, frames: [], idx: RADAR_OFFSETS.length - 1, timer: null, playing: true };

function radarUrl(min) {
  const layer = min === 0 ? 'nexrad-n0q-900913' : `nexrad-n0q-900913-m${String(min).padStart(2, '0')}m`;
  // Round to 5 minutes so tiles cache between frames but refresh as new scans arrive.
  const stamp = Math.floor(Date.now() / 300000);
  return `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/${layer}/{z}/{x}/{y}.png?_=${stamp}`;
}

function renderRadar(lat, lon, station) {
  $('#radar-card').hidden = false;
  $('#radar-link').href = station ? `https://radar.weather.gov/station/${station}/standard` : 'https://radar.weather.gov/';
  if (!window.L) { $('#radar-map').textContent = 'The map library failed to load.'; return; }

  if (!radar.map) {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    radar.map = L.map('radar-map', { attributionControl: true }).setView([lat, lon], 7);
    const esri = (name) => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${dark ? 'Dark' : 'Light'}_Gray_${name}/MapServer/tile/{z}/{y}/{x}`;
    L.tileLayer(esri('Base'), { maxZoom: 12, attribution: 'Basemap &copy; Esri' }).addTo(radar.map);
    radar.frames = RADAR_OFFSETS.map((m) =>
      L.tileLayer(radarUrl(m), { opacity: 0, maxZoom: 12, attribution: 'NEXRAD via IEM' }).addTo(radar.map));
    // Place labels above the radar so city names stay readable.
    radar.map.createPane('labels').style.zIndex = 450;
    radar.map.getPane('labels').style.pointerEvents = 'none';
    L.tileLayer(esri('Reference'), { maxZoom: 12, pane: 'labels' }).addTo(radar.map);
    radar.marker = L.circleMarker([lat, lon], { radius: 6, color: '#fff', weight: 2, fillColor: '#0f5ea8', fillOpacity: 1 }).addTo(radar.map);
    $('#radar-play').addEventListener('click', toggleRadar);
  } else {
    radar.map.setView([lat, lon], radar.map.getZoom());
    radar.marker.setLatLng([lat, lon]);
    radar.frames.forEach((f, i) => f.setUrl(radarUrl(RADAR_OFFSETS[i])));
  }
  showFrame(radar.idx);
  if (radar.playing) startRadar();
  setTimeout(() => radar.map.invalidateSize(), 0);
}

function showFrame(i) {
  radar.frames.forEach((f, j) => f.setOpacity(j === i ? 0.75 : 0));
  const m = RADAR_OFFSETS[i];
  $('#radar-time').textContent = m === 0 ? 'Latest' : `−${m} min`;
}

function startRadar() {
  clearTimeout(radar.timer);
  const step = () => {
    radar.idx = (radar.idx + 1) % radar.frames.length;
    showFrame(radar.idx);
    radar.timer = setTimeout(step, radar.idx === radar.frames.length - 1 ? 1800 : 450);
  };
  radar.timer = setTimeout(step, 600);
}

function toggleRadar() {
  radar.playing = !radar.playing;
  const btn = $('#radar-play');
  if (radar.playing) { startRadar(); btn.textContent = 'Pause'; btn.setAttribute('aria-label', 'Pause animation'); }
  else {
    clearTimeout(radar.timer);
    radar.idx = radar.frames.length - 1; showFrame(radar.idx);
    btn.textContent = 'Play'; btn.setAttribute('aria-label', 'Play animation');
  }
}

// ---------- forecast discussion ----------
async function loadDiscussion(office) {
  const card = $('#afd-card');
  try {
    const list = await nws(`/products/types/AFD/locations/${office}`);
    const latest = list['@graph']?.[0];
    if (!latest) { card.hidden = true; return; }
    const prod = await nws(`/products/${latest.id}`);
    $('#afd-meta').textContent = `NWS ${office} · ${fmtTime(prod.issuanceTime, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
    // Drop the WMO/AWIPS header lines and the trailing "$$" marker for readability.
    $('#afd-text').textContent = prod.productText.replace(/^[\s\S]*?(?=Area Forecast Discussion)/i, '').replace(/\n\$\$[\s\S]*$/, '').trim();
    card.hidden = false;
  } catch {
    card.hidden = true;
  }
}

// ---------- location: search, GPS, saved ----------
function choose(p) {
  place = { lat: +p.lat, lon: +p.lon, name: p.name || null };
  store.set('place', place);
  if (!saved.some((s) => Math.abs(s.lat - place.lat) < 0.01 && Math.abs(s.lon - place.lon) < 0.01) && place.name) {
    saved.unshift(place); saved = saved.slice(0, 10); store.set('saved', saved);
  }
  $('#search-dlg').close();
  window.scrollTo({ top: 0 });
  load();
}

function useGps() {
  if (!navigator.geolocation) { setStatus('Location is not available in this browser.', true); return; }
  setStatus('Finding your location…');
  navigator.geolocation.getCurrentPosition(
    (pos) => { place = { lat: pos.coords.latitude, lon: pos.coords.longitude, name: null }; store.set('place', place); load(); },
    (err) => { setStatus(`Couldn't get your location (${err.message}). Search for a place instead.`, true); if (!place) openSearch(); },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 }
  );
}

function renderSaved() {
  const ul = $('#saved-list');
  if (!saved.length) { ul.innerHTML = '<li class="empty">Places you pick are saved here.</li>'; return; }
  ul.innerHTML = saved.map((s, i) => `<li>
    <button class="pick" data-i="${i}">${esc(s.name)}</button>
    <button class="del" data-del="${i}" aria-label="Remove ${esc(s.name)}">✕</button></li>`).join('');
}

function openSearch() {
  renderSaved();
  $('#search-results').innerHTML = '';
  $('#search-dlg').showModal();
  $('#search-input').focus();
}

async function search(q) {
  const ul = $('#search-results');
  const coords = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (coords) { choose({ lat: coords[1], lon: coords[2] }); return; }
  ul.innerHTML = '<li class="empty">Searching…</li>';
  try {
    // "Boulder, CO" → search "Boulder" and prefer results in that state.
    const [name, region] = q.split(',').map((s) => s.trim());
    const res = await fetch(`${GEOCODE}?name=${encodeURIComponent(name)}&count=10&countryCode=US&language=en&format=json`);
    let results = (await res.json()).results || [];
    if (region) {
      const r = region.toLowerCase();
      const match = (x) => (x.admin1 || '').toLowerCase().startsWith(r) || STATE_ABBR[x.admin1] === region.toUpperCase();
      results = [...results.filter(match), ...results.filter((x) => !match(x))];
    }
    if (!results.length) { ul.innerHTML = '<li class="empty">No US places found.</li>'; return; }
    ul._results = results;
    ul.innerHTML = results.map((r, i) => `<li><button class="pick" data-r="${i}">${esc(r.name)}${r.admin1 ? `, ${esc(STATE_ABBR[r.admin1] || r.admin1)}` : ''}${r.admin2 ? ` <span class="muted small">${esc(r.admin2)}</span>` : ''}</button></li>`).join('');
  } catch {
    ul.innerHTML = '<li class="empty">Search failed. Check your connection.</li>';
  }
}

const STATE_ABBR = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE',
  'District of Columbia': 'DC', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA',
  Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN',
  Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ',
  'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR',
  Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT',
  Vermont: 'VT', Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY', 'Puerto Rico': 'PR',
};

// ---------- wiring ----------
$('#loc-btn').addEventListener('click', openSearch);
$('#gps-btn').addEventListener('click', useGps);
$('#refresh-btn').addEventListener('click', load);
$('#search-close').addEventListener('click', () => $('#search-dlg').close());
$('#search-form').addEventListener('submit', (e) => { e.preventDefault(); const q = $('#search-input').value.trim(); if (q) search(q); });
$('#search-results').addEventListener('click', (e) => {
  const b = e.target.closest('[data-r]'); if (!b) return;
  const r = e.currentTarget._results[+b.dataset.r];
  choose({ lat: r.latitude, lon: r.longitude, name: `${r.name}, ${STATE_ABBR[r.admin1] || r.admin1 || ''}`.replace(/, $/, '') });
});
$('#saved-list').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) { saved.splice(+del.dataset.del, 1); store.set('saved', saved); renderSaved(); return; }
  const b = e.target.closest('[data-i]'); if (b) choose(saved[+b.dataset.i]);
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && place && Date.now() - lastLoad > REFRESH_MS) load();
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

if (place) load();
else { setStatus('Pick a location to get started.'); useGps(); }
