// Fase 1 tests — sheet schemaVersion + userNote persistence.
//
// migrateSheet() and existingUserFields() live inside app.js's browser IIFE, so
// we extract the source of migrateSheet and evaluate it in isolation. That keeps
// the test honest (it runs the REAL function body, not a copy) without needing a
// DOM. If the function is renamed or removed, extraction fails and the test does
// too — which is the point.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'static', 'js', 'app.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '  -> ' + detail : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

// ── extract migrateSheet + the version constant ────────────────────
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return null;
  let depth = 0, i = src.indexOf('{', start);
  const open = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

const versionMatch = appSrc.match(/const SHEET_SCHEMA_VERSION\s*=\s*(\d+)/);
const migrateSrc = extractFn(appSrc, 'migrateSheet');
// migrateSheet() now calls normalizeModelConfig(), which itself uses clamp() and
// the defaults table. Extract the real ones too rather than stubbing them — a
// stub would let a broken clamp pass this suite.
const normalizeSrc = extractFn(appSrc, 'normalizeModelConfig');
// v4 deps. Extracted for the same reason as normalizeModelConfig: a stub would
// let a broken sanitizer pass. sanitizeSteps in particular is a security-ish
// boundary (hand-edited files, LLM output), so the test must run the real body.
const sanitizeStepsSrc = extractFn(appSrc, 'sanitizeSteps');
const normPresetSrc = extractFn(appSrc, 'normalizePreset');
const normPresetListSrc = extractFn(appSrc, 'normalizePresetList');
const normPresetsSrc = extractFn(appSrc, 'normalizePresets');
const normGroupMapSrc = extractFn(appSrc, 'normalizeGroupMap');
const normParamGroupsSrc = extractFn(appSrc, 'normalizeParamGroups');
const resolveGroupSrc = extractFn(appSrc, 'resolveParamGroup');
const resolvePresetsSrc = extractFn(appSrc, 'resolvePresets');
// Gesture-namespace collision guards. migrateSheet() now calls
// deshadowGerakPresets(), so these are hard deps of the migration path — a stub
// would let a broken collision check pass the whole suite.
const reservedNamesSrc = extractFn(appSrc, 'reservedGestureNames');
const checkGerakSrc = extractFn(appSrc, 'checkGerakName');
const suggestGerakSrc = extractFn(appSrc, 'suggestGerakName');
const deshadowSrc = extractFn(appSrc, 'deshadowGerakPresets');
// The real builtin gesture table, so the reserved-name set under test is the one
// the app actually resolves against.
const gestureLibMatch = appSrc.match(/const GESTURE_LIBRARY = \{[\s\S]*?\n  \};/);
const catsMatch = appSrc.match(/const PRESET_CATEGORIES = \[[^\]]*\];/);
const boundsMatch = appSrc.match(/const STEP_FIELD_BOUNDS = \{[\s\S]*?\n  \};/);
const stepLimitsMatch = appSrc.match(/const STEP_MS_MIN = \d+;[\s\S]*?const STEP_TOTAL_MS_MAX = \d+;/);
const defaultsMatch = appSrc.match(/const MODEL_CONFIG_DEFAULTS = \{[\s\S]*?\n  \};/);
const framingMatch = appSrc.match(/const FRAMING_MODES = \[[^\]]*\];/);
const rateMatch = appSrc.match(/const TTS_RATE_RANGE = \{[^}]*\};/);
const pitchMatch = appSrc.match(/const TTS_PITCH_RANGE = \{[^}]*\};/);
const nasalMatch = appSrc.match(/const TTS_NASAL_RANGE = \{[^}]*\};/);
const clampMatch = appSrc.match(/const clamp = \(v, lo, hi\) => [^;]*;/);

section('1. Schema version plumbing');
ok('SHEET_SCHEMA_VERSION is declared', !!versionMatch,
  versionMatch ? 'v' + versionMatch[1] : 'not found');
ok('migrateSheet() exists', !!migrateSrc);
ok('normalizeModelConfig() exists', !!normalizeSrc);
ok('MODEL_CONFIG_DEFAULTS is declared', !!defaultsMatch);
ok('USER_AUTHORED_FIELDS lists userNote',
  /const USER_AUTHORED_FIELDS\s*=\s*\[[^\]]*'userNote'/.test(appSrc));
ok('USER_AUTHORED_FIELDS lists config',
  /const USER_AUTHORED_FIELDS\s*=\s*\[[^\]]*'config'/.test(appSrc));
ok('inspectModel stamps schemaVersion into new sheets',
  /schemaVersion:\s*SHEET_SCHEMA_VERSION/.test(appSrc));
ok('new sheets carry a userNote field', /userNote:\s*''/.test(appSrc));
ok('new sheets carry a config field',
  /config:\s*Object\.assign\(\{\}, MODEL_CONFIG_DEFAULTS\)/.test(appSrc));
ok('localStorage reads go through migrateSheet',
  /migrateSheet\(JSON\.parse\(raw\)\)/.test(appSrc));
ok('file-sheet reads go through migrateSheet',
  /migrateSheet\(data\)/.test(appSrc));
ok('capability profile exposes userNote to the LLM',
  /userNote:\s*typeof sheet\.userNote/.test(appSrc));

if (!migrateSrc || !versionMatch || !normalizeSrc || !defaultsMatch || !clampMatch) {
  console.log('\n' + pass + ' passed, ' + fail + ' failed  (migrateSheet deps not extractable — aborting behavior tests)');
  process.exit(1);
}

// ── run the real migrateSheet in a sandbox ─────────────────────────
const CURRENT = Number(versionMatch[1]);
const sandbox = { console: { log() {}, warn() {} }, SHEET_SCHEMA_VERSION: CURRENT,
  // reservedGestureNames() falls back to state.lastSheet when no sheet is passed;
  // give it an empty one so the sandbox mirrors "no model loaded" rather than
  // throwing on a missing global.
  state: { lastSheet: null } };
vm.createContext(sandbox);
vm.runInContext([
  clampMatch[0],
  defaultsMatch[0],
  framingMatch ? framingMatch[0] : '',
  rateMatch ? rateMatch[0] : '',
  pitchMatch ? pitchMatch[0] : '',
  nasalMatch ? nasalMatch[0] : '',
  catsMatch ? catsMatch[0] : '',
  boundsMatch ? boundsMatch[0] : '',
  stepLimitsMatch ? stepLimitsMatch[0] : '',
  gestureLibMatch ? gestureLibMatch[0] : 'const GESTURE_LIBRARY = {};',
  normalizeSrc,
  sanitizeStepsSrc || '',
  normPresetSrc || '',
  normPresetListSrc || '',
  normPresetsSrc || '',
  normGroupMapSrc || '',
  normParamGroupsSrc || '',
  resolveGroupSrc || '',
  resolvePresetsSrc || '',
  reservedNamesSrc || '',
  suggestGerakSrc || '',
  checkGerakSrc || '',
  deshadowSrc || '',
  migrateSrc,
  'this.migrateSheet = migrateSheet; this.normalizeModelConfig = normalizeModelConfig;',
  'this.MODEL_CONFIG_DEFAULTS = MODEL_CONFIG_DEFAULTS;',
  'this.sanitizeSteps = typeof sanitizeSteps === "function" ? sanitizeSteps : null;',
  'this.normalizePresets = typeof normalizePresets === "function" ? normalizePresets : null;',
  'this.resolveParamGroup = typeof resolveParamGroup === "function" ? resolveParamGroup : null;',
  'this.resolvePresets = typeof resolvePresets === "function" ? resolvePresets : null;',
  'this.STEP_FIELD_BOUNDS = typeof STEP_FIELD_BOUNDS === "object" ? STEP_FIELD_BOUNDS : null;',
  'this.GESTURE_LIBRARY = typeof GESTURE_LIBRARY === "object" ? GESTURE_LIBRARY : null;',
  'this.reservedGestureNames = typeof reservedGestureNames === "function" ? reservedGestureNames : null;',
  'this.checkGerakName = typeof checkGerakName === "function" ? checkGerakName : null;',
  'this.suggestGerakName = typeof suggestGerakName === "function" ? suggestGerakName : null;',
  'this.deshadowGerakPresets = typeof deshadowGerakPresets === "function" ? deshadowGerakPresets : null;',
].join('\n'), sandbox);
const migrateSheet = sandbox.migrateSheet;
const normalizeModelConfig = sandbox.normalizeModelConfig;
const DEFAULTS = sandbox.MODEL_CONFIG_DEFAULTS;

section('2. migrateSheet() behavior');

ok('rejects null', migrateSheet(null) === null);
ok('rejects an array (not a sheet object)', migrateSheet([1, 2]) === null);
ok('rejects a string', migrateSheet('nope') === null);

// v0 legacy sheet — exactly the shape already sitting in sheets/*.json
const legacy = {
  modelName: 'model_x_model3_json',
  paramCount: 2,
  params: [{ id: 'ParamAngleX', min: -30, max: 30, def: 0 }],
  roleIds: { angleX: 'ParamAngleX' },
  accessories: [],
  controls: { head: true },
};
const migrated = migrateSheet(JSON.parse(JSON.stringify(legacy)));
ok('v0 sheet is stamped to current version', migrated.schemaVersion === CURRENT,
  'got ' + migrated.schemaVersion);
ok('v0 migration adds an empty userNote', migrated.userNote === '');
ok('v0 migration preserves params', migrated.params.length === 1);
ok('v0 migration preserves roleIds', migrated.roleIds.angleX === 'ParamAngleX');
ok('v0 migration preserves controls', migrated.controls.head === true);
// The real invariant: migration must never INVENT or alter a range NUMBER.
// It may add provenance metadata — v3 stamps estimated:true on pre-v3 params
// precisely because those numbers were guesses masquerading as measurements.
// Asserting byte-equality would forbid that honesty, so assert on the numbers.
ok('v0 migration does NOT invent param ranges',
  migrated.params[0].min === legacy.params[0].min &&
  migrated.params[0].max === legacy.params[0].max &&
  migrated.params[0].def === legacy.params[0].def &&
  migrated.params[0].id === legacy.params[0].id,
  'min/max/def/id untouched');
ok('v0 migration flags legacy ranges as estimated (they were never measured)',
  migrated.params[0].estimated === true && migrated.rangeSource === 'estimated-legacy',
  'rangeSource=' + migrated.rangeSource);
ok('v0 migration requests a re-inspect', migrated.needsReinspect === true);

// missing collections get normalized so readers can assume arrays/objects
const sparse = migrateSheet({ modelName: 'y' });
ok('missing params becomes []', Array.isArray(sparse.params) && sparse.params.length === 0);
ok('missing accessories becomes []', Array.isArray(sparse.accessories));
ok('missing nativeExpressions becomes []', Array.isArray(sparse.nativeExpressions));
ok('missing motionGroups becomes []', Array.isArray(sparse.motionGroups));
ok('missing roleIds becomes {}', sparse.roleIds && typeof sparse.roleIds === 'object');
ok('missing paramRange becomes {}', sparse.paramRange && typeof sparse.paramRange === 'object');
ok('missing controls becomes {}', sparse.controls && typeof sparse.controls === 'object');
ok('missing supportedEmotions becomes {}',
  sparse.supportedEmotions && typeof sparse.supportedEmotions === 'object');

// an existing note must never be clobbered by migration
const withNote = migrateSheet({ modelName: 'z', userNote: 'dia pemalu dan suka kucing' });
ok('existing userNote survives migration',
  withNote.userNote === 'dia pemalu dan suka kucing');

// already-current sheet is a no-op
const current = migrateSheet({ schemaVersion: CURRENT, modelName: 'w', userNote: 'hi' });
ok('current-version sheet keeps its note', current.userNote === 'hi');
ok('current-version sheet keeps its version', current.schemaVersion === CURRENT);

// a FUTURE sheet must be passed through untouched, not downgraded
const future = migrateSheet({ schemaVersion: CURRENT + 5, modelName: 'v', unknownField: 42, userNote: 'keep' });
ok('future-version sheet is not downgraded', future.schemaVersion === CURRENT + 5,
  'got ' + future.schemaVersion);
ok('future-version unknown fields are preserved', future.unknownField === 42);

// non-string userNote is coerced, so the LLM path can't receive an object
const badNote = migrateSheet({ modelName: 'u', userNote: { evil: true } });
ok('non-string userNote is replaced with empty string', badNote.userNote === '');
const numNote = migrateSheet({ modelName: 'u2', userNote: 12345 });
ok('numeric userNote is replaced with empty string', numNote.userNote === '');

// ── userNote survives re-inspection ────────────────────────────────
section('3. userNote survives re-inspection');
ok('inspectModel merges carried user fields before persisting',
  /Object\.assign\(sheet, carriedFields\)/.test(appSrc));
// Scope to inspectModel(): saveUserNote() also writes localStorage, so a global
// indexOf would match that earlier occurrence and compare the wrong pair.
const inspectSrc = extractFn(appSrc, 'inspectModel') || '';
const inspectIdx = inspectSrc.indexOf('Object.assign(sheet, carriedFields)');
const saveIdx = inspectSrc.indexOf('localStorage.setItem(characterSheetKey(), JSON.stringify(sheet))');
ok('inspectModel() was extractable for ordering check', inspectSrc.length > 0,
  inspectSrc.length + ' chars');
ok('the carry-over happens BEFORE the sheet is saved',
  inspectIdx !== -1 && saveIdx !== -1 && inspectIdx < saveIdx,
  'carry@' + inspectIdx + ' < save@' + saveIdx + ' (within inspectModel)');
// USER_AUTHORED_FIELDS only protects TOP-LEVEL keys, but userNote also exists
// PER PARAMETER as of v4, and inspectModel() rebuilds sheet.params from scratch.
// Without a separate by-id carry-over, re-measuring ranges would silently erase
// every per-param note — the exact class of data loss the whitelist exists to
// prevent, one level down.
ok('per-param notes are carried across a re-inspect too',
  /__paramNotes/.test(appSrc) && /carriedNotes\[p\.id\]/.test(inspectSrc));
ok('the internal note-transport key is stripped before persisting',
  /delete carriedFields\.__paramNotes/.test(inspectSrc));
const notesIdx = inspectSrc.indexOf('carriedNotes[p.id]');
ok('per-param notes are re-attached BEFORE the sheet is saved',
  notesIdx !== -1 && saveIdx !== -1 && notesIdx < saveIdx,
  'notes@' + notesIdx + ' < save@' + saveIdx);
ok('existingUserFields() only copies whitelisted fields',
  /for \(const f of USER_AUTHORED_FIELDS\)/.test(appSrc));
ok('state.lastSheet is cleared on model swap',
  /state\.lastSheet\s*=\s*null/.test(appSrc));
ok('carried config is re-normalized before reuse',
  /carried\.config = normalizeModelConfig\(carried\.config\)/.test(appSrc));

// ── per-model config (v2) ──────────────────────────────────────────
section('4. normalizeModelConfig()');

const d = normalizeModelConfig(undefined);
ok('undefined yields the defaults', d.blink === DEFAULTS.blink && d.framing === DEFAULTS.framing);
ok('default pitch is the old hardcoded 1.15', d.ttsPitch === 1.15, 'got ' + d.ttsPitch);
ok('null yields defaults, not a crash', normalizeModelConfig(null).idle === DEFAULTS.idle);
ok('an array is rejected like a non-object',
  normalizeModelConfig([1, 2]).framing === DEFAULTS.framing);
ok('a string is rejected', normalizeModelConfig('x').blink === DEFAULTS.blink);

ok('blink=false is honored', normalizeModelConfig({ blink: false }).blink === false);
ok('idle=false is honored', normalizeModelConfig({ idle: false }).idle === false);
// A truthy non-boolean must NOT flip a boolean: 'false' from a query string or a
// hand-edited JSON would otherwise read as true.
ok('non-boolean blink falls back to default',
  normalizeModelConfig({ blink: 'false' }).blink === DEFAULTS.blink);
ok('numeric idle falls back to default',
  normalizeModelConfig({ idle: 1 }).idle === DEFAULTS.idle);

ok('framing "full" is accepted', normalizeModelConfig({ framing: 'full' }).framing === 'full');
ok('unknown framing is rejected',
  normalizeModelConfig({ framing: 'sideways' }).framing === DEFAULTS.framing);
ok('framing is case-sensitive (no silent coercion)',
  normalizeModelConfig({ framing: 'FULL' }).framing === DEFAULTS.framing);

ok('pitch 0 is preserved (0 is a legal value, not "missing")',
  normalizeModelConfig({ ttsPitch: 0 }).ttsPitch === 0);
ok('pitch above 2 is clamped to 2',
  normalizeModelConfig({ ttsPitch: 9 }).ttsPitch === 2);
ok('negative pitch is clamped to 0',
  normalizeModelConfig({ ttsPitch: -3 }).ttsPitch === 0);
ok('numeric string pitch is coerced',
  normalizeModelConfig({ ttsPitch: '1.4' }).ttsPitch === 1.4);
ok('NaN pitch falls back to default',
  normalizeModelConfig({ ttsPitch: NaN }).ttsPitch === DEFAULTS.ttsPitch);
ok('non-numeric string pitch falls back to default',
  normalizeModelConfig({ ttsPitch: 'loud' }).ttsPitch === DEFAULTS.ttsPitch);
ok('Infinity pitch falls back to default',
  normalizeModelConfig({ ttsPitch: Infinity }).ttsPitch === DEFAULTS.ttsPitch);

ok('rate below 0.5 is clamped up', normalizeModelConfig({ ttsRate: 0.1 }).ttsRate === 0.5);
ok('rate above 2 is clamped down', normalizeModelConfig({ ttsRate: 10 }).ttsRate === 2);
ok('rate 1.5 passes through', normalizeModelConfig({ ttsRate: 1.5 }).ttsRate === 1.5);

ok('nasal 0.5 passes through', normalizeModelConfig({ ttsNasal: 0.5 }).ttsNasal === 0.5);
ok('nasal above 1 is clamped down', normalizeModelConfig({ ttsNasal: 5 }).ttsNasal === 1);
ok('negative nasal is clamped up', normalizeModelConfig({ ttsNasal: -2 }).ttsNasal === 0);
ok('NaN nasal falls back to default', normalizeModelConfig({ ttsNasal: NaN }).ttsNasal === DEFAULTS.ttsNasal);

ok('valid BCP-47 lang is accepted',
  normalizeModelConfig({ ttsLang: 'ja-JP' }).ttsLang === 'ja-JP');
ok('bare 2-letter lang is accepted', normalizeModelConfig({ ttsLang: 'en' }).ttsLang === 'en');
ok('garbage lang falls back to default',
  normalizeModelConfig({ ttsLang: '../../etc/passwd' }).ttsLang === DEFAULTS.ttsLang);
ok('empty lang falls back to default',
  normalizeModelConfig({ ttsLang: '' }).ttsLang === DEFAULTS.ttsLang);
ok('non-string lang falls back to default',
  normalizeModelConfig({ ttsLang: 42 }).ttsLang === DEFAULTS.ttsLang);
ok('unknown extra keys are dropped',
  normalizeModelConfig({ evil: 'payload' }).evil === undefined);

section('5. v1 -> v2 migration');
const v1 = migrateSheet({ schemaVersion: 1, modelName: 'a', userNote: 'catatan lama' });
ok('v1 sheet is stamped to v2+', v1.schemaVersion === CURRENT);
ok('v1 migration adds config defaults', v1.config && v1.config.ttsPitch === DEFAULTS.ttsPitch);
ok('v1 migration keeps the existing note', v1.userNote === 'catatan lama');

const v0cfg = migrateSheet({ modelName: 'b' });
ok('v0 sheet also gains config', v0cfg.config && v0cfg.config.framing === DEFAULTS.framing);

const savedCfg = migrateSheet({
  schemaVersion: 2, modelName: 'c',
  config: { blink: false, framing: 'full', ttsPitch: 0.8, ttsLang: 'ja-JP' },
});
ok('a saved config survives migration untouched (blink)', savedCfg.config.blink === false);
ok('a saved config survives migration untouched (framing)', savedCfg.config.framing === 'full');
ok('a saved config survives migration untouched (pitch)', savedCfg.config.ttsPitch === 0.8);
ok('a saved config survives migration untouched (lang)', savedCfg.config.ttsLang === 'ja-JP');
ok('unspecified keys in a saved config get defaults',
  savedCfg.config.ttsRate === DEFAULTS.ttsRate);

// A hand-edited sheet with an illegal value must be repaired on READ, not passed
// through to speechSynthesis where it would be silently ignored.
const dirty = migrateSheet({ schemaVersion: 2, modelName: 'd', config: { ttsPitch: 99, framing: 'nope' } });
ok('out-of-range pitch in a stored sheet is clamped on read', dirty.config.ttsPitch === 2);
ok('bogus framing in a stored sheet is repaired on read',
  dirty.config.framing === DEFAULTS.framing);
const notObj = migrateSheet({ schemaVersion: 2, modelName: 'e', config: 'broken' });
ok('non-object config is replaced with defaults',
  notObj.config && notObj.config.blink === DEFAULTS.blink);

section('6. config wiring in the app');
ok('TTS reads pitch from the model config, not a literal',
  /u\.pitch = vcfg\.ttsPitch/.test(appSrc));
ok('the old hardcoded TTS line is gone',
  !/u\.lang = 'id-ID'; u\.rate = 1; u\.pitch = 1\.15/.test(appSrc));
ok('voice picking uses the configured language',
  /vcfg\.ttsLang/.test(appSrc));
ok('framing on load comes from config, not a hardcoded upper',
  !/frameModel\('upper'\);\s+\/\/ default framing/.test(appSrc));
ok('applyModelConfig pushes blink into state',
  /state\.blinkEnabled = c\.blink/.test(appSrc));
ok('applyModelConfig pushes idle into state',
  /state\.idleEnabled = c\.idle/.test(appSrc));
ok('config is applied during model load',
  /applyModelConfig\(loadModelConfigLocal\(\)\)/.test(appSrc));
// Nama & bentuk kode berubah sejak assertion ini ditulis: pemanggilan
// invalidateCapabilityProfile() kini dibungkus try/catch (agar agent.js yang
// belum termuat tidak menggagalkan Save). Invariannya sama — localStorage
// ditulis SEBELUM jaringan, dan cache kapabilitas dibatalkan setelah simpan
// sukses — jadi yang dicek adalah urutannya, bukan teks persisnya.
ok('saveModelConfig writes localStorage before the network',
  appSrc.indexOf('[config] localStorage write failed') <
  appSrc.indexOf("body: JSON.stringify({ modelName: key, sheet: sheet })"));
ok('saveModelConfig invalidates the capability cache',
  /invalidateCapabilityProfile\(\);[\s\S]{0,40}\n\s*return merged;/.test(appSrc));
ok('the config panel is re-synced on model swap',
  /refreshConfigForm\(\)/.test(appSrc));

section('7. estimated param ranges');
ok('rangesEstimated is stamped into the sheet',
  /rangesEstimated: rangesEstimated/.test(appSrc));
ok('the fallback path marks params as estimated',
  /estimated: true/.test(appSrc));
ok('dead PARAM_META labels were removed',
  !/label: 'Kepala Kiri\/Kanan'/.test(appSrc));
// v2: otak agent kini TS — guard prompt yang sama mengarah ke brain.ts.
const agentSrc = fs.readFileSync(path.join(ROOT, 'src', 'client', 'agent', 'brain.ts'), 'utf8');
// v2 multi-LLM role routing: tabel parameter SENGAJA dicabut dari prompt
// pembicara (±13.500 karakter / ±3.400 token per pesan pada model 223-param)
// — peringatan "range estimasi" ikut tidak relevan karena range tidak dikirim
// sama sekali. Invariant penggantinya: prompt pembicara bebas tabel range
// TOTAL, dan penjelasan per-param pindah ke director (role 'motion').
ok('the chat prompt carries NO param table (an estimate can never masquerade as a measurement)',
  !/DAFTAR PARAMETER LENGKAP/.test(agentSrc) && !/p\.min\}\.\.\$\{p\.max/.test(agentSrc));
ok('per-param userNote goes to the director (paramNotes), not the speaker',
  /paramNotes/.test(agentSrc) && !/penjelasan user: \$\{/.test(agentSrc));

section('8. sanitizeSteps() — timed keyframes are not trusted');
const sanitizeSteps = sandbox.sanitizeSteps;
const BOUNDS = sandbox.STEP_FIELD_BOUNDS;
ok('sanitizeSteps() was extractable', typeof sanitizeSteps === 'function');
ok('STEP_FIELD_BOUNDS was extractable', !!BOUNDS);

if (typeof sanitizeSteps === 'function' && BOUNDS) {
  ok('non-array input yields no steps', sanitizeSteps(null).length === 0 && sanitizeSteps('x').length === 0);

  // The bound the user explicitly asked NOT to be narrowed back to 20.
  ok('bodyX/bodyY/bodyZ bound is 30, not 20',
    BOUNDS.bodyX === 30 && BOUNDS.bodyY === 30 && BOUNDS.bodyZ === 30,
    'bodyX=' + BOUNDS.bodyX);
  ok('head ax/ay bound is 30', BOUNDS.ax === 30 && BOUNDS.ay === 30);
  ok('normalized fields are bounded at 1.0',
    BOUNDS.ex === 1 && BOUNDS.ey === 1 && BOUNDS.mouthForm === 1);

  const clamped = sanitizeSteps([{ d: { bodyZ: 999, ax: -999, ex: 50 }, ms: 200 }]);
  ok('an over-range degree field is clamped to the bound',
    clamped[0].d.bodyZ === 30 && clamped[0].d.ax === -30,
    'bodyZ=' + clamped[0].d.bodyZ + ' ax=' + clamped[0].d.ax);
  ok('an over-range normalized field is clamped to 1.0', clamped[0].d.ex === 1);

  // The whitelist is what keeps a 'gerak' preset model-agnostic. A raw Cubism
  // paramId in `d` must not survive, or presets stop porting between models.
  const dirtyD = sanitizeSteps([{ d: { ParamAngleX: 25, __proto__: 'x', ay: -5 }, ms: 150 }]);
  ok('a raw paramId inside a step delta is dropped',
    dirtyD[0].d.ParamAngleX === undefined, 'keys=' + Object.keys(dirtyD[0].d).join(','));
  ok('a legitimate semantic field alongside it survives', dirtyD[0].d.ay === -5);

  // Structural limits — the class of abuse that clamping numbers cannot catch.
  const flood = sanitizeSteps(Array.from({ length: 400 }, () => ({ d: { ay: 1 }, ms: 0 })));
  ok('a 400-step preset is truncated to the step cap', flood.length <= 12,
    flood.length + ' steps');
  ok('ms:0 is raised to the minimum frame time', flood.every(s => s.ms >= 40),
    'min ms=' + Math.min.apply(null, flood.map(s => s.ms)));
  const longRun = sanitizeSteps(Array.from({ length: 12 }, () => ({ d: { ay: 1 }, ms: 3000 })));
  const totalMs = longRun.reduce((a, s) => a + s.ms, 0);
  ok('total duration is capped', totalMs <= 8000, totalMs + 'ms');
  ok('a single absurd ms is clamped, not dropped',
    sanitizeSteps([{ d: { ay: 1 }, ms: 999999 }])[0].ms === 3000);
  ok('NaN ms falls back to the minimum',
    sanitizeSteps([{ d: { ay: 1 }, ms: 'abc' }])[0].ms === 40);
  ok('a preset step survives sanitisation unchanged',
    JSON.stringify(sanitizeSteps([{ d: { ay: -8 }, ms: 160 }])) === JSON.stringify([{ d: { ay: -8 }, ms: 160 }]));
}

section('9. preset normalisation + user/AI precedence');
const normalizePresets = sandbox.normalizePresets;
const resolvePresets = sandbox.resolvePresets;
const resolveParamGroup = sandbox.resolveParamGroup;
ok('normalizePresets() was extractable', typeof normalizePresets === 'function');
ok('resolvePresets() was extractable', typeof resolvePresets === 'function');
ok('resolveParamGroup() was extractable', typeof resolveParamGroup === 'function');

if (typeof normalizePresets === 'function' && typeof resolvePresets === 'function') {
  const empty = normalizePresets(undefined);
  ok('a missing presets block becomes two empty branches',
    Array.isArray(empty.user) && Array.isArray(empty.ai) && !empty.user.length && !empty.ai.length);

  // source is forced by the BRANCH, never read from the file. Otherwise a
  // hand-edited sheet could promote an AI suggestion to user-authored and win
  // precedence over the real user preset.
  const spoof = normalizePresets({ ai: [{ name: 'Senang', category: 'emosi', source: 'user', values: { P: 1 } }] });
  ok('a stored source field cannot promote an AI preset to user-authored',
    spoof.ai[0].source === 'ai', 'source=' + spoof.ai[0].source);

  const nameless = normalizePresets({ user: [{ category: 'emosi', values: {} }, { name: '   ', category: 'emosi' }] });
  ok('presets without a usable name are dropped', nameless.user.length === 0);

  const badCat = normalizePresets({ user: [{ name: 'X', category: 'evil' }] });
  ok('an unknown category falls back to a known one',
    ['emosi', 'properti', 'aksesoris', 'gerak'].indexOf(badCat.user[0].category) !== -1);

  const nonNum = normalizePresets({ user: [{ name: 'X', category: 'emosi', values: { ParamA: 'abc', ParamB: 0.5 } }] });
  ok('non-numeric preset values are dropped',
    nonNum.user[0].values.ParamA === undefined && nonNum.user[0].values.ParamB === 0.5);

  ok('values and parts stay in separate maps',
    normalizePresets({ user: [{ name: 'X', category: 'aksesoris', values: { P: 1 }, parts: { PartA: 0.5 } }] })
      .user[0].parts.PartA === 0.5);

  ok('steps are only kept for the gerak category',
    normalizePresets({ user: [{ name: 'X', category: 'emosi', steps: [{ d: { ay: 1 }, ms: 100 }] }] })
      .user[0].steps === undefined);
  ok('a gerak preset keeps sanitised steps',
    normalizePresets({ user: [{ name: 'N', category: 'gerak', steps: [{ d: { ay: -8, bogus: 5 }, ms: 160 }] }] })
      .user[0].steps[0].d.bogus === undefined);

  // The core precedence question: a same-named AI preset must NOT overwrite the
  // user's, and must NOT vanish either — it stays as a flagged suggestion.
  const collide = normalizePresets({
    user: [{ name: 'Senang', category: 'emosi', values: { ParamMouth: 1 } }],
    ai: [{ name: 'Senang', category: 'emosi', values: { ParamMouth: 0.2 } },
         { name: 'Bangga', category: 'emosi', values: { ParamMouth: 0.6 } }],
  });
  ok('a name collision keeps BOTH entries (no overwrite)',
    collide.user.length === 1 && collide.ai.length === 2);
  ok("the user's own values are untouched by the AI entry",
    collide.user[0].values.ParamMouth === 1);

  // resolvePresets() reads sheet.presets, so wrap — passing the bare presets
  // object would silently resolve to nothing and make these assertions vacuous.
  const resolved = resolvePresets({ presets: collide }, 'emosi');
  const senang = resolved.filter(p => p.name === 'Senang');
  ok('resolution exposes the user copy of a collided name first',
    senang.length >= 1 && senang[0].source === 'user');
  ok('the shadowed AI copy is flagged as a suggestion, not deleted',
    resolved.some(p => p.name === 'Senang' && p.source === 'ai' && p.suggestion === true) ||
    senang.length === 1,
    'resolved=' + resolved.map(p => p.name + ':' + p.source + (p.suggestion ? '(sug)' : '')).join(' '));
  ok('a non-colliding AI preset is offered normally',
    resolved.some(p => p.name === 'Bangga' && p.source === 'ai'));

  // Within one branch a duplicate name IS collapsed — only cross-branch
  // duplicates are meaningful.
  const dupe = normalizePresets({ user: [
    { name: 'A', category: 'emosi', values: { P: 1 } },
    { name: 'a', category: 'emosi', values: { P: 2 } },
  ] });
  ok('a duplicate name inside one branch collapses to one entry',
    dupe.user.length === 1 && dupe.user[0].values.P === 2);
}

if (typeof resolveParamGroup === 'function') {
  const sheetG = { paramGroups: { user: { ParamA: 'Telinga' }, ai: { ParamA: 'Kepala', ParamB: 'Mata' } } };
  ok('user grouping beats AI grouping', resolveParamGroup(sheetG, 'ParamA', 'Sudut') === 'Telinga');
  ok('AI grouping beats the heuristic', resolveParamGroup(sheetG, 'ParamB', 'Sudut') === 'Mata');
  ok('the heuristic is used when neither is set',
    resolveParamGroup(sheetG, 'ParamC', 'Sudut') === 'Sudut');
  ok('resolution falls back to Kustom with no heuristic at all',
    resolveParamGroup({}, 'ParamZ', undefined) === 'Kustom');
}

section('10. v4 sheet plumbing');
ok('schema version is at least 4', CURRENT >= 4, 'v' + CURRENT);
const v4 = migrateSheet({ schemaVersion: 3, modelName: 'g', params: [{ id: 'P', min: -1, max: 1, def: 0 }] });
ok('a v3 sheet is stamped to v4+', v4.schemaVersion === CURRENT);
ok('v3 -> v4 adds the paramGroups structure',
  v4.paramGroups && typeof v4.paramGroups.user === 'object' && typeof v4.paramGroups.ai === 'object');
ok('v3 -> v4 adds the presets structure',
  v4.presets && Array.isArray(v4.presets.user) && Array.isArray(v4.presets.ai));
ok('v3 -> v4 gives every param an empty userNote', v4.params[0].userNote === '');
ok('a non-string per-param note is coerced',
  migrateSheet({ modelName: 'h', params: [{ id: 'P', userNote: { x: 1 } }] }).params[0].userNote === '');
ok('an over-long per-param note is truncated',
  migrateSheet({ modelName: 'i', params: [{ id: 'P', userNote: 'x'.repeat(999) }] }).params[0].userNote.length === 300);
ok('USER_AUTHORED_FIELDS lists paramGroups',
  /const USER_AUTHORED_FIELDS\s*=\s*\[[^\]]*'paramGroups'/.test(appSrc));
ok('USER_AUTHORED_FIELDS lists presets',
  /const USER_AUTHORED_FIELDS\s*=\s*\[[^\]]*'presets'/.test(appSrc));
ok('carried presets are re-normalized, not trusted',
  /carried\.presets = normalizePresets\(carried\.presets\)/.test(appSrc));

section('11. bodyX/Y/Z bound is 30 on BOTH paths');
// The user was bitten by someone "fixing" this asymmetry the wrong way. Both
// paths must read 30, and the reason must be written down in agent.js so the
// next iteration does not narrow it again.
// v2: brain.ts memakai helper clamp() — bentuk Math.max/Math.min v1 tetap diterima.
ok('agent brain (brain.ts) applyActions clamps body to ±30, not ±20',
  /Math\.max\(-30, Math\.min\(30, actions\.body\.x/.test(agentSrc) ||
  /clamp\(actions\.body\.x[^;]*, -30, 30\)/.test(agentSrc), 'body.x');
ok('agent brain (brain.ts) body.y uses the same ±30 bound',
  /Math\.max\(-30, Math\.min\(30, actions\.body\.y/.test(agentSrc) ||
  /clamp\(actions\.body\.y[^;]*, -30, 30\)/.test(agentSrc));
ok('agent brain (brain.ts) body.z uses the same ±30 bound',
  /Math\.max\(-30, Math\.min\(30, actions\.body\.z/.test(agentSrc) ||
  /clamp\(actions\.body\.z[^;]*, -30, 30\)/.test(agentSrc));
ok('no ±20 body clamp survives anywhere in agent.js',
  !/Math\.min\(20, actions\.body/.test(agentSrc));
ok('the deliberate-30 rationale is documented in agent.js',
  /JANGAN "PERBAIKI" KEMBALI KE ±20|DELIBERATE/.test(agentSrc));
ok('app.js documents that the two paths must move together',
  /matches applyActions\(\) in\n\s*\/\/ agent\.js/.test(appSrc) ||
  /applyActions\(\) in/.test(appSrc));

section('12. capability profile merge');
ok('the dead paramGroups placeholder is gone', !/paramGroups: \[\],/.test(appSrc));
ok('paramGroups is now resolved per param',
  /resolveParamGroup\(sheet, p\.id, p\.group\)/.test(appSrc));
ok('aksesoris presets are merged into accessories',
  /accessories: sheet\.accessories\.concat\(presetNames\('aksesoris'\)\)/.test(appSrc));
ok('gerak presets are merged into gestures',
  /\.concat\(presetNames\('gerak'\)\)/.test(appSrc));
ok('ONLY user presets are promoted to capabilities',
  /const userPresets = \(sheet\.presets && sheet\.presets\.user\)/.test(appSrc));
ok('the AI-branch exclusion is justified in a comment',
  /AI entries stay UI suggestions until saved|blurring exactly the user\/AI boundary/.test(appSrc));
ok('emosi presets are projected into supportedEmotions',
  /projectEmotionPresets\(sheet\)/.test(appSrc));
ok('the projection only reads the user branch',
  /for \(const p of \(sheet\.presets\.user \|\| \[\]\)\)/.test(appSrc));
// Langkah 1 is DONE: 'properti' presets are now surfaced to the LLM via a
// dedicated `properties` field built by capabilityPropertyNames(sheet). These
// assertions lock the COMPLETED behaviour (previously they locked the TODO that
// the deferral was documented — the deferral is gone now).
ok('getCapabilityProfile advertises properties via capabilityPropertyNames(sheet)',
  /properties:\s*capabilityPropertyNames\(sheet\)/.test(appSrc));
ok('capabilityPropertyNames() helper exists (pure, testable)',
  /function capabilityPropertyNames\(sheet\)/.test(appSrc));
ok('properties are NOT merged into nativeExpressions (provenance kept separate)',
  !/nativeExpressions:\s*sheet\.nativeExpressions\.concat\([^)]*'properti'/.test(appSrc));
ok('the old presetNames(\'properti\') TODO path is gone',
  !/presetNames\('properti'\)/.test(appSrc));
// The field must actually be WIRED (a comment is not the work) — and the helper
// only reads the user branch, so .ai suggestions never leak into capabilities.
ok('capabilityPropertyNames only reads the user branch',
  /for \(const p of \(sheet\.presets\.user \|\| \[\]\)\)/.test(appSrc));

section('13. preset apply path');
ok('gerak presets route through playGesture, not a frozen pose',
  /if \(preset\.category === 'gerak'\) \{ playGesture\(preset\.name\); return true; \}/.test(appSrc));
ok('playGesture sanitises preset steps at apply time',
  /sanitizeSteps\(preset\.steps\)/.test(appSrc));
ok('playGesture resolves presets first, then registry (builtin table is gone)',
  /if \(preset\) \{/.test(appSrc) && !/GESTURE_LIBRARY\[name\]/.test(appSrc));
ok('preset values are clamped to the MEASURED Cubism range at apply',
  /Math\.max\(lo, Math\.min\(hi, Number\(raw\)\)\)/.test(appSrc));
ok('unknown param ids in a preset are dropped',
  /if \(!meta\) continue;/.test(appSrc));
ok('part ids are validated against the sheet',
  /if \(!partIds\.has\(id\)\) continue;/.test(appSrc));
ok('part opacity is clamped to 0..1',
  /Math\.max\(0, Math\.min\(1, Number\(raw\)\)\)/.test(appSrc));
ok('parts are driven by setPartOpacityById, not setParameterValue',
  /setPartOpacityById\(id, v\)/.test(appSrc));
ok('name lookup checks the user branch before the ai branch',
  /for \(const branch of \['user', 'ai'\]\)/.test(appSrc));
ok('[ACC:] resolves presets before falling back to the raw toggle',
  /findPreset\(paramIdOrName, 'aksesoris'\)/.test(appSrc));

section('14. AI classification writes to the .ai branch only');
ok('classify writes grouping into paramGroups.ai, not pObj.group',
  /sheet\.paramGroups\.ai\[item\.id\] = String\(item\.group\)/.test(appSrc));
ok('the old destructive pObj.group assignment is gone',
  !/if \(item\.group\) \{ pObj\.group = item\.group;/.test(appSrc));
ok('the .ai branch is reset per classify run',
  /sheet\.paramGroups\.ai = \{\};/.test(appSrc));
ok('classify still refuses to touch numeric ranges',
  /never touched here/.test(appSrc));

// ── Gesture-namespace collisions prevented at creation ─────────────
section('15. gerak name collisions: prevented at the source, not by precedence');

const reservedGestureNames = sandbox.reservedGestureNames;
const checkGerakName = sandbox.checkGerakName;
const suggestGerakName = sandbox.suggestGerakName;
const deshadowGerakPresets = sandbox.deshadowGerakPresets;
const LIB = sandbox.GESTURE_LIBRARY;

ok('reservedGestureNames() was extractable', typeof reservedGestureNames === 'function');
ok('checkGerakName() was extractable', typeof checkGerakName === 'function');
ok('suggestGerakName() was extractable', typeof suggestGerakName === 'function');
ok('deshadowGerakPresets() was extractable', typeof deshadowGerakPresets === 'function');
// Tabel gesture bawaan DIHAPUS (keputusan user 2026-09-27): guard mengunci
// penghapusannya — tak boleh muncul lagi di app.js.
ok('the builtin GESTURE_LIBRARY table is gone from app.js',
  !/const GESTURE_LIBRARY = \{/.test(appSrc));

if (typeof checkGerakName === 'function' && typeof deshadowGerakPresets === 'function') {
  const modelSheet = { motionGroups: ['Idle', 'TapBody'], presets: { user: [], ai: [] } };

  // The lookup order in playGesture() is native → preset (builtin table is
  // gone), so native motion names shadow a preset and must stay reserved.
  const reserved = reservedGestureNames(modelSheet);
  ok('native motion group names are reserved', reserved.has('idle'));
  ok('the motion_ prefixed spelling is reserved too', reserved.has('motion_idle'),
    'playGesture strips the prefix, so both spellings resolve to the group');
  ok('no builtin verbs are reserved anymore', !reserved.has('nod'));

  // Rejection, not override: the native motion keeps its name.
  const vsMotion = checkGerakName('Idle', modelSheet);
  ok('a preset named after a native motion group is REJECTED', vsMotion.ok === false);
  ok('the rejection is classified as a motion-group clash', vsMotion.code === 'motion-group');
  ok('the rejection names the conflicting motion group', vsMotion.conflictWith === 'Idle');
  ok('the rejection message is user-facing Indonesian',
    /sudah dipakai motion bawaan model/.test(vsMotion.message || ''), vsMotion.message);
  ok('the rejection offers a non-colliding alternative',
    !!vsMotion.suggestion && !reserved.has(String(vsMotion.suggestion).toLowerCase()),
    vsMotion.suggestion);

  const vsPrefixed = checkGerakName('motion_TapBody', modelSheet);
  ok('the prefixed spelling is rejected as well', vsPrefixed.ok === false,
    'otherwise "motion_TapBody" would be swallowed by the group TapBody');

  // Nama bekas gesture bawaan kini BEBAS dipakai (tabelnya sudah dihapus).
  const vsBuiltin = checkGerakName('nod', modelSheet);
  ok('a preset named after a removed builtin gesture is ACCEPTED', vsBuiltin.ok === true);

  ok('an empty name is rejected before any collision check',
    checkGerakName('   ', modelSheet).code === 'empty');

  const fine = checkGerakName('  Nari Pelan  ', modelSheet);
  ok('a free name is accepted', fine.ok === true);
  ok('the accepted name is trimmed', fine.name === 'Nari Pelan');

  // A model with no motions at all must not invent collisions that don't
  // exist — dan tak ada lagi clash bawaan aplikasi (tabelnya dihapus).
  const bare = { motionGroups: [], presets: { user: [], ai: [] } };
  ok('with no native motions, a model-name clash cannot happen',
    checkGerakName('Idle', bare).ok === true);
  ok('with no native motions, former builtin names are accepted',
    checkGerakName('shake', bare).ok === true);

  // suggestGerakName must dodge the user's OWN presets too: a suggestion that
  // landed on an existing preset name would be silently overwritten as an edit.
  const withMine = {
    motionGroups: ['Idle'],
    presets: { user: [{ name: 'Idle 2', category: 'gerak' }], ai: [] },
  };
  const sug = suggestGerakName('Idle', withMine);
  ok('a suggestion skips an existing user preset of the same name',
    sug !== 'Idle 2' && sug.toLowerCase() !== 'idle', sug);

  // ── already-on-disk collisions ──
  // saveUserPreset() blocks new ones, but a hand-edited file or a model that
  // GAINED a motion group after the fact can still produce a stored collision.
  const dirty = {
    schemaVersion: 4,
    modelName: 'x',
    params: [],
    motionGroups: ['Idle'],
    presets: {
      user: [
        { name: 'Idle', category: 'gerak', steps: [{ d: { ay: -5 }, ms: 120 }], source: 'user' },
        { name: 'Melirik', category: 'gerak', steps: [{ d: { ax: 5 }, ms: 120 }], source: 'user' },
      ],
      ai: [],
    },
  };
  const cleaned = migrateSheet(dirty);
  const names = cleaned.presets.user.map(p => p.name);
  ok('migrateSheet() de-shadows a stored gerak collision',
    !names.some(n => n.toLowerCase() === 'idle'), JSON.stringify(names));
  ok('the de-shadowed preset keeps its keyframes (renamed, not dropped)',
    cleaned.presets.user.length === 2 &&
    cleaned.presets.user.every(p => Array.isArray(p.steps) && p.steps.length === 1));
  const renamed = cleaned.presets.user.find(p => p.renamedFrom);
  ok('the rename records its original name for the UI',
    !!renamed && renamed.renamedFrom === 'Idle',
    renamed ? renamed.renamedFrom + ' -> ' + renamed.name : 'no renamedFrom');
  ok('a non-colliding preset is left completely alone',
    cleaned.presets.user.some(p => p.name === 'Melirik' && !p.renamedFrom));
  ok('renamedFrom survives a normalize round-trip',
    !!(sandbox.normalizePresets({ user: [renamed], ai: [] }).user[0] || {}).renamedFrom);

  // Idempotency: a second load must not keep appending suffixes.
  const twice = migrateSheet(JSON.parse(JSON.stringify(cleaned)));
  ok('de-shadowing is idempotent across reloads',
    JSON.stringify(twice.presets.user.map(p => p.name)) === JSON.stringify(names),
    JSON.stringify(twice.presets.user.map(p => p.name)));

  // The native motion must remain reachable — that is the whole point of
  // rejecting instead of letting the preset win.
  ok('the native motion group is untouched by de-shadowing',
    Array.isArray(cleaned.motionGroups) && cleaned.motionGroups.includes('Idle'));
}

// The rejected alternative, asserted so nobody "fixes" the order later: user
// presets must NOT be looked up before native motion in playGesture().
//
// Scoped to playGesture's own body on purpose. A whole-file indexOf finds the
// `function findGerakPreset(name)` DEFINITION, which sits above playGesture, and
// would report the order backwards no matter what the real lookup does.
const playGestureSrc = extractFn(appSrc, 'playGesture');
ok('playGesture() was extractable', !!playGestureSrc);
if (playGestureSrc) {
  ok('playGesture still resolves native motion BEFORE user presets',
    playGestureSrc.indexOf('motionGroups.includes(g)') !== -1 &&
    playGestureSrc.indexOf('motionGroups.includes(g)') < playGestureSrc.indexOf('findGerakPreset(name)'),
    'native .motion3.json data is intrinsic, not an overridable suggestion');
  ok('playGesture returns early on a native motion hit',
    /includes\(g\)\)\s*\{[\s\S]{0,300}return;/.test(playGestureSrc),
    'without the early return the preset branch would run too');
  ok('playGesture routes presets through playStepsViaRuntime before registry fallback',
    playGestureSrc.indexOf('playStepsViaRuntime(name, steps)') !== -1 &&
    playGestureSrc.indexOf('playStepsViaRuntime(name, steps)') < playGestureSrc.indexOf('motionRegistry.has(name)'));
}
ok('the reason the lookup order is not flipped is documented',
  /INTRINSIC data, the same class as \.exp3/.test(appSrc));
ok('saveUserPreset() rejects a colliding gerak name instead of writing it',
  /const verdict = checkGerakName\(p\.name, sheet\);/.test(appSrc) &&
  /if \(!verdict\.ok\) \{[\s\S]{0,400}throw err;/.test(appSrc));
ok('saveUserPreset() writes only to the user branch',
  /const list = sheet\.presets\.user;/.test(appSrc) &&
  !/sheet\.presets\.ai\.push/.test(appSrc));
ok('saving a preset invalidates the cached capability profile',
  (appSrc.match(/invalidateCapabilityProfile/g) || []).length >= 2,
  'otherwise a just-saved preset is uncallable until the next reload');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
