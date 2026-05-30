const fs = require('fs');
const path = require('path');

const indexPath  = path.join(__dirname, '../node_modules/fca-unofficial/index.js');
const listenPath = path.join(__dirname, '../node_modules/fca-unofficial/src/listenMqtt.js');
const utilsPath  = path.join(__dirname, '../node_modules/fca-unofficial/utils.js');

// ══════════════════════════════════════════════════════════════════
// Patch 1: index.js — Facebook 2025+ MqttWebConfig regex
// ══════════════════════════════════════════════════════════════════
let idx = fs.readFileSync(indexPath, 'utf8');
if (!idx.includes('quotedFBMQTTMatch')) {
  const OLD = `      } else {
        log.warn("login", "Cannot get MQTT region & sequence ID.");
        noMqttData = html;
      }`;
  const NEW = `      } else {
        // Facebook 2025+: quoted JSON keys in MqttWebConfig
        var quotedFBMQTTMatch = html.match(/\\["MqttWebConfig",\\[\\],\\{"fbid":"(.+?)","appID":219994525426954,"endpoint":"(.+?)"/);
        if (quotedFBMQTTMatch) {
          mqttEndpoint = quotedFBMQTTMatch[2].replace(/\\\\\\//g, "/");
          region = new URL(mqttEndpoint).searchParams.get("region").toUpperCase();
          log.info("login", \`Got this account's message region: \${region}\`);
        } else {
          log.warn("login", "Cannot get MQTT region & sequence ID.");
          noMqttData = html;
        }
      }`;
  if (idx.includes(OLD)) {
    idx = idx.replace(OLD, NEW);
    fs.writeFileSync(indexPath, idx);
    console.log('[patch-fca] index.js: MqttWebConfig 2025+ regex patched OK');
  } else {
    console.warn('[patch-fca] index.js: target not found — already patched or changed');
  }
} else {
  console.log('[patch-fca] index.js: already patched');
}

// ══════════════════════════════════════════════════════════════════
// Patch 2: utils.js — Modern fb_dtsg extraction (DTSGInitData format)
// ══════════════════════════════════════════════════════════════════
let utils = fs.readFileSync(utilsPath, 'utf8');
if (!utils.includes('DTSGInitData')) {
  // Try both spacing variants
  const targets = [
    "  var fb_dtsg = getFrom(html, 'name=\"fb_dtsg\" value=\"', '\"');",
    "var fb_dtsg = getFrom(html, 'name=\"fb_dtsg\" value=\"', '\"');",
  ];
  const dtsgPatch = `  var fb_dtsg = getFrom(html, 'name="fb_dtsg" value="', '"');
  if (!fb_dtsg) {
    var _dtsgM = html.match(/"DTSGInitData",\\[\\],\\{"token":"([^"]+)"/) ||
                 html.match(/"DTSGInitData",\\[\\],\\{"token":"([^"]+)"/);
    if (_dtsgM) { fb_dtsg = _dtsgM[1]; log.info("makeDefaults", "fb_dtsg via DTSGInitData OK"); }
  }`;
  let patched = false;
  for (const target of targets) {
    if (utils.includes(target)) {
      utils = utils.replace(target, dtsgPatch);
      patched = true;
      break;
    }
  }
  if (patched) {
    fs.writeFileSync(utilsPath, utils);
    console.log('[patch-fca] utils.js: DTSGInitData fb_dtsg patched OK');
  } else {
    console.warn('[patch-fca] utils.js: fb_dtsg target not found — skipping');
  }
} else {
  console.log('[patch-fca] utils.js: already patched');
}

// ══════════════════════════════════════════════════════════════════
// Patch 3: listenMqtt.js — fix ALL "av": ctx.globalOptions.pageID
//
// ROOT CAUSE: pageID is empty when using AppState (no Page token).
// getSeqID sends av="" → Facebook returns error → seqId never set
// → MQTT starts with lastSeqId=null → only "presence" events, NO messages.
//
// FIX: Replace pageID with (pageID || userID) in ALL 3 locations:
//   1. getSeqID form (line ~765) — critical: without this seqId fetch fails
//   2. parseDelta ForcedFetch (line ~533) — group image messages
//   3. parseDelta replyToMessageId (line ~400) — message replies
// ══════════════════════════════════════════════════════════════════
let lmq = fs.readFileSync(listenPath, 'utf8');

const avOld = '"av": ctx.globalOptions.pageID,';
const avNew = '"av": ctx.globalOptions.pageID || ctx.userID,';
const occurrencesBefore = (lmq.split(avOld).length - 1);

if (occurrencesBefore > 0) {
  lmq = lmq.split(avOld).join(avNew);
  console.log(`[patch-fca] listenMqtt.js: fixed "av" in ${occurrencesBefore} location(s)`);
} else {
  console.log('[patch-fca] listenMqtt.js: "av" already patched');
}

// ══════════════════════════════════════════════════════════════════
// Patch 4: listenMqtt.js — REMOVE the "skip seqId on error" workaround.
//
// The old patch replaced the catch with "proceed without seqId" which
// caused MQTT to start without lastSeqId → only presence events.
// Now that Patch 3 fixes the av field, getSeqID will succeed, so
// we restore the original error propagation behavior.
// ══════════════════════════════════════════════════════════════════

// If the bad patch is present, revert it to the original behavior
const BAD_CATCH = `      .catch((err) => {
        log.warn("getSeqId", "getSeqId failed, proceeding without seqId:", err && err.error || String(err));
        listenMqtt(defaultFuncs, api, ctx, globalCallback);
      });`;

const GOOD_CATCH = `      .catch((err) => {
        log.error("getSeqId", err);
        if (utils.getType(err) == "Object" && err.error === "Not logged in") {
          ctx.loggedIn = false;
        }
        return globalCallback(err);
      });`;

if (lmq.includes(BAD_CATCH)) {
  lmq = lmq.replace(BAD_CATCH, GOOD_CATCH);
  console.log('[patch-fca] listenMqtt.js: reverted bad catch — getSeqId errors now propagate correctly');
} else if (lmq.includes('proceeding without seqId')) {
  console.warn('[patch-fca] listenMqtt.js: bad catch found but string mismatch — check manually');
} else {
  console.log('[patch-fca] listenMqtt.js: catch is already correct (original behavior)');
}

fs.writeFileSync(listenPath, lmq);

const avFixed = (lmq.match(/ctx\.globalOptions\.pageID \|\| ctx\.userID/g) || []).length;
console.log(`[patch-fca] listenMqtt.js: Done. av||userID in ${avFixed} location(s).`);
console.log('[patch-fca] All patches complete. getSeqId will now fetch real lastSeqId → messages will be received.');
