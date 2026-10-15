/**
 * Faceless Pipeline — Universal Publish & Schedule Box Component
 *
 * Provides a complete multi-platform publishing studio for:
 *   - YouTube Shorts
 *   - Facebook Reels
 *   - Instagram Reels
 *   - TikTok (Content Posting API v2)
 *
 * Supports immediate publishing and scheduled queueing with quick time presets.
 * Works seamlessly across all pages: Reels, Dialogue, Verses, and Cards.
 */
(function (global) {
  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function toDatetimeLocal(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function formatRelativeTime(targetMs) {
    const diff = targetMs - Date.now();
    if (diff <= 0) return 'due now';
    const mins = Math.round(diff / 60000);
    if (mins < 60) return `in ${mins} min${mins === 1 ? '' : 's'}`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (hours < 24)
      return `in ${hours} hr${hours === 1 ? '' : 's'}${remMins > 0 ? ` ${remMins}m` : ''}`;
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return `in ${days} day${days === 1 ? '' : 's'}${remHours > 0 ? ` ${remHours}h` : ''}`;
  }

  function mountPublishBox(container, options = {}) {
    if (!container) return null;
    const prefix = options.prefix || 'pb_';
    const id = (name) => (name && name.startsWith(prefix) ? name : `${prefix}${name}`);
    const $ = (name) => container.querySelector(`#${id(name)}`);

    let currentSlug = (typeof options.getSlug === 'function' ? options.getSlug() : options.slug) || '';
    let pubStatus = null;
    let pubSchedules = [];
    let pubMode = 'now'; // 'now' | 'schedule'
    let lastLoadedPubSlug = '';
    let busy = false;

    // Render HTML template inside container
    container.innerHTML = `
      <div class="pub-box-wrapper" style="display: flex; flex-direction: column; gap: 14px;">
        <!-- Top Toolbar -->
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;">
          <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
            <button id="${id('toggleBtn')}" class="small" type="button" style="display: inline-flex; align-items: center; gap: 5px; font-weight: 700; background: var(--panel-2); border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; cursor: pointer;">
              <span id="${id('toggleIcon')}">▼</span>
              <span id="${id('toggleText')}">Collapse</span>
            </button>
            <h2 id="${id('titleToggle')}" style="margin: 0; font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 6px; cursor: pointer;" title="Click to expand or collapse">
              <span>🚀</span> Publish &amp; Schedule
            </h2>
            <div style="display: flex; align-items: center; gap: 6px;">
              <span class="hint" style="font-size: 12px; margin: 0;">Reel:</span>
              <select id="${id('reelSelect')}" style="font-size: 12px; padding: 3px 8px; width: auto; max-width: 240px; border-radius: 6px;"></select>
            </div>
            <span id="${id('globalReelHint')}" class="hint" style="font-size: 12px;"></span>
            <span id="${id('statusSummary')}" class="hint" style="font-size: 11px; padding: 2px 8px; border-radius: 10px; border: 1px solid var(--line); display: none;"></span>
          </div>
          <div id="${id('topActions')}" style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <button id="${id('autofillBtn')}" class="small" type="button" title="Auto-fill captions and tags from reel project">⚡ Auto-fill from Reel</button>
            <button id="${id('saveDraftBtn')}" class="small" type="button" title="Save custom captions without publishing">💾 Save Draft</button>
            <label class="hint" style="margin: 0; display: inline-flex; gap: 6px; align-items: center; font-size: 12px; cursor: pointer;">
              <input type="checkbox" id="${id('again')}" style="width: auto;" /> Repost if already published
            </label>
            <button id="${id('publishAllBtn')}" class="small" type="button" style="background: var(--accent); color: #0d1117; border-color: var(--accent); font-weight: 700; padding: 5px 14px;">
              🚀 Publish to All Connected
            </button>
          </div>
        </div>

        <!-- Collapsible Body Section -->
        <div id="${id('body')}" style="display: flex; flex-direction: column; gap: 14px;">
          <!-- Publish Mode Selector -->
          <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; background: rgba(0,0,0,0.22); padding: 7px 12px; border-radius: 8px; border: 1px solid var(--line);">
            <div style="display: flex; align-items: center; gap: 10px;">
              <span style="font-size: 13px; font-weight: 600;">Publish Mode:</span>
              <div style="display: inline-flex; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 2px;">
                <button id="${id('modeNowBtn')}" type="button" class="small" style="background: var(--accent); color: #0d1117; font-weight: 700; border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer;">⚡ Publish Now</button>
                <button id="${id('modeSchedBtn')}" type="button" class="small" style="background: transparent; color: var(--muted); font-weight: 600; border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer;">📅 Schedule for Later</button>
              </div>
            </div>
            <div id="${id('modeHint')}" class="hint" style="font-size: 12px;">Publish directly to connected platforms</div>
          </div>

        <!-- Schedule Configuration Panel -->
        <div id="${id('schedulePanel')}" hidden style="background: var(--panel-2); border: 1px solid var(--accent); border-radius: 8px; padding: 12px 14px;">
          <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-bottom: 10px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <b style="font-size: 13px;">📅 Target Date &amp; Time:</b>
              <input type="datetime-local" id="${id('scheduleTime')}" style="font-size: 13px; padding: 5px 8px; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; color: var(--fg); width: auto;" />
            </div>
            <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
              <span class="hint" style="font-size: 11px;">Quick presets:</span>
              <button type="button" class="small ${id('preset-btn')}" data-preset="30m" style="padding: 2px 7px; font-size: 11px;">+30m</button>
              <button type="button" class="small ${id('preset-btn')}" data-preset="1h" style="padding: 2px 7px; font-size: 11px;">+1h</button>
              <button type="button" class="small ${id('preset-btn')}" data-preset="3h" style="padding: 2px 7px; font-size: 11px;">+3h</button>
              <button type="button" class="small ${id('preset-btn')}" data-preset="tonight8" style="padding: 2px 7px; font-size: 11px;">Tonight 8 PM</button>
              <button type="button" class="small ${id('preset-btn')}" data-preset="tomorrow10" style="padding: 2px 7px; font-size: 11px;">Tomorrow 10 AM</button>
              <button type="button" class="small ${id('preset-btn')}" data-preset="tomorrow8" style="padding: 2px 7px; font-size: 11px;">Tomorrow 8 PM</button>
            </div>
          </div>
          <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding-top: 8px; border-top: 1px solid var(--line);">
            <div id="${id('schedulePreview')}" style="font-size: 12px; color: var(--accent); font-weight: 600;">
              Select a date and time to schedule
            </div>
            <label class="hint" style="margin: 0; display: inline-flex; gap: 6px; align-items: center; font-size: 11px; cursor: pointer;">
              <input type="checkbox" id="${id('nativeUpload')}" style="width: auto;" />
              Upload YouTube &amp; Facebook right away with native platform schedule
            </label>
          </div>
        </div>

        <!-- App Credentials Accordion -->
        <details style="margin: 2px 0 6px;">
          <summary class="hint" style="cursor: pointer; margin: 0; font-size: 12px;">
            🔑 App credentials &amp; setup instructions (YouTube, Facebook, Instagram, TikTok)
          </summary>
          <div style="margin-top: 10px; background: rgba(0,0,0,0.18); padding: 12px; border-radius: 8px; border: 1px solid var(--line);">
            <div class="row two">
              <div>
                <label for="${id('ytClientId')}" style="font-size: 11px;">YOUTUBE_CLIENT_ID</label>
                <input id="${id('ytClientId')}" autocomplete="off" style="font-size: 12px;" />
              </div>
              <div>
                <label for="${id('ytClientSecret')}" style="font-size: 11px;">YOUTUBE_CLIENT_SECRET</label>
                <input id="${id('ytClientSecret')}" type="password" autocomplete="off" style="font-size: 12px;" />
              </div>
            </div>
            <div class="row two">
              <div>
                <label for="${id('metaAppId')}" style="font-size: 11px;">META_APP_ID</label>
                <input id="${id('metaAppId')}" autocomplete="off" style="font-size: 12px;" />
              </div>
              <div>
                <label for="${id('metaAppSecret')}" style="font-size: 11px;">META_APP_SECRET</label>
                <input id="${id('metaAppSecret')}" type="password" autocomplete="off" style="font-size: 12px;" />
              </div>
            </div>
            <div class="row two">
              <div>
                <label for="${id('tiktokClientKey')}" style="font-size: 11px;">TIKTOK_CLIENT_KEY</label>
                <input id="${id('tiktokClientKey')}" autocomplete="off" style="font-size: 12px;" />
              </div>
              <div>
                <label for="${id('tiktokClientSecret')}" style="font-size: 11px;">TIKTOK_CLIENT_SECRET</label>
                <input id="${id('tiktokClientSecret')}" type="password" autocomplete="off" style="font-size: 12px;" />
              </div>
            </div>
            <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-top: 8px;">
              <div class="hint" style="font-size: 11px;">
                Redirect URIs: <code id="${id('ytRedirect')}"></code>, <code id="${id('metaRedirect')}"></code>, <code id="${id('tiktokRedirect')}"></code>
              </div>
              <button id="${id('saveKeysBtn')}" class="small" type="button" style="background: var(--accent); color: #0d1117; font-weight: 700; padding: 4px 12px;">
                💾 Save keys to .env
              </button>
            </div>
          </div>
        </details>

        <!-- 4 Platform Cards Grid -->
        <div class="pub-cards-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px;">
          <!-- Card 1: YouTube Shorts -->
          <div class="conn" style="display: flex; flex-direction: column; gap: 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px;">
            <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line); padding-bottom: 8px;">
              <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-size: 16px;">▶️</span>
                <b style="font-size: 13px;">YouTube Shorts</b>
              </div>
              <span id="${id('ytBadge')}" class="pub-badge" style="font-size: 11px; padding: 2px 8px; border-radius: 10px;">Checking...</span>
            </div>
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 28px;">
              <div id="${id('ytStatus')}" class="hint" style="font-size: 11px; flex: 1;"></div>
              <div style="display: flex; gap: 6px;">
                <a id="${id('ytConnect')}" class="small btn" href="/oauth/youtube/start" style="padding: 2px 8px; font-size: 11px;">Connect</a>
                <button id="${id('ytDisconnect')}" class="small" hidden style="padding: 2px 8px; font-size: 11px;">Disconnect</button>
              </div>
            </div>
            <div>
              <label for="${id('ytTitle')}" style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 3px;">
                <span>Shorts Title</span>
                <span id="${id('ytTitleCount')}" class="hint" style="font-size: 11px;">0/100</span>
              </label>
              <input id="${id('ytTitle')}" maxlength="100" placeholder="(Shorts title)" style="font-size: 12px;" />
            </div>
            <div>
              <label for="${id('ytDescription')}" style="font-size: 11px; margin-bottom: 3px;">Description</label>
              <textarea id="${id('ytDescription')}" rows="3" placeholder="(description)" style="font-size: 12px;"></textarea>
            </div>
            <div class="row two" style="margin: 0; gap: 8px;">
              <div>
                <label for="${id('ytHashtags')}" style="font-size: 11px; margin-bottom: 3px;">Tags / Hashtags</label>
                <input id="${id('ytHashtags')}" placeholder="#shorts #islamic" style="font-size: 12px;" />
              </div>
              <div>
                <label for="${id('ytPrivacy')}" style="font-size: 11px; margin-bottom: 3px;">Privacy</label>
                <select id="${id('ytPrivacy')}" style="font-size: 12px;">
                  <option value="public">public</option>
                  <option value="unlisted">unlisted</option>
                  <option value="private">private</option>
                </select>
              </div>
            </div>
            <div id="${id('ytResult')}" class="hint" style="font-size: 11px; padding: 6px 10px; background: rgba(0,0,0,0.25); border-radius: 6px; min-height: 28px; display: flex; align-items: center; margin-top: auto;">Not published yet</div>
            <button id="${id('publishYtBtn')}" class="small" style="background: #e62117; color: #fff; border-color: #e62117; font-weight: 600; padding: 7px 12px; width: 100%;">
              ▶ Publish to YouTube
            </button>
          </div>

          <!-- Card 2: Facebook Reels -->
          <div class="conn" style="display: flex; flex-direction: column; gap: 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px;">
            <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line); padding-bottom: 8px;">
              <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-size: 16px;">📘</span>
                <b style="font-size: 13px;">Facebook Reels</b>
              </div>
              <span id="${id('fbBadge')}" class="pub-badge" style="font-size: 11px; padding: 2px 8px; border-radius: 10px;">Checking...</span>
            </div>
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 28px;">
              <div id="${id('metaStatus')}" class="hint" style="font-size: 11px; flex: 1;"></div>
              <div style="display: flex; gap: 6px; align-items: center;">
                <a id="${id('metaConnect')}" class="small btn" href="/oauth/meta/start" style="padding: 2px 8px; font-size: 11px;">Connect</a>
                <select id="${id('metaPage')}" hidden style="font-size: 11px; padding: 2px 6px; width: auto; max-width: 140px;"></select>
                <button id="${id('metaDisconnect')}" class="small" hidden style="padding: 2px 8px; font-size: 11px;">Disconnect</button>
              </div>
            </div>
            <div>
              <label for="${id('fbTitle')}" style="font-size: 11px; margin-bottom: 3px;">Title / Heading (optional)</label>
              <input id="${id('fbTitle')}" placeholder="(reel title)" style="font-size: 12px;" />
            </div>
            <div>
              <label for="${id('fbDescription')}" style="font-size: 11px; margin-bottom: 3px;">Caption / Description</label>
              <textarea id="${id('fbDescription')}" rows="3" placeholder="(Facebook caption)" style="font-size: 12px;"></textarea>
            </div>
            <div class="row two" style="margin: 0; gap: 8px;">
              <div>
                <label for="${id('fbHashtags')}" style="font-size: 11px; margin-bottom: 3px;">Hashtags</label>
                <input id="${id('fbHashtags')}" placeholder="#facebookreels #bangla" style="font-size: 12px;" />
              </div>
              <div>
                <label for="${id('fbCoverAt')}" style="font-size: 11px; margin-bottom: 3px;">Cover Frame (sec)</label>
                <input id="${id('fbCoverAt')}" type="number" step="0.1" min="0" placeholder="1.0" style="font-size: 12px;" />
              </div>
            </div>
            <div id="${id('fbResult')}" class="hint" style="font-size: 11px; padding: 6px 10px; background: rgba(0,0,0,0.25); border-radius: 6px; min-height: 28px; display: flex; align-items: center; margin-top: auto;">Not published yet</div>
            <button id="${id('publishFbBtn')}" class="small" style="background: #1877f2; color: #fff; border-color: #1877f2; font-weight: 600; padding: 7px 12px; width: 100%;">
              📘 Publish to Facebook
            </button>
          </div>

          <!-- Card 3: Instagram Reels -->
          <div class="conn" style="display: flex; flex-direction: column; gap: 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px;">
            <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line); padding-bottom: 8px;">
              <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-size: 16px;">📷</span>
                <b style="font-size: 13px;">Instagram Reels</b>
              </div>
              <span id="${id('igBadge')}" class="pub-badge" style="font-size: 11px; padding: 2px 8px; border-radius: 10px;">Checking...</span>
            </div>
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 28px;">
              <div id="${id('igStatus')}" class="hint" style="font-size: 11px; flex: 1;">Linked via Facebook Page</div>
            </div>
            <div>
              <label for="${id('igDescription')}" style="font-size: 11px; margin-bottom: 3px;">Caption</label>
              <textarea id="${id('igDescription')}" rows="5" placeholder="(Instagram caption)" style="font-size: 12px;"></textarea>
            </div>
            <div class="row two" style="margin: 0; gap: 8px;">
              <div>
                <label for="${id('igHashtags')}" style="font-size: 11px; margin-bottom: 3px;">Hashtags</label>
                <input id="${id('igHashtags')}" placeholder="#reels #explore" style="font-size: 12px;" />
              </div>
              <div>
                <label for="${id('igCoverAt')}" style="font-size: 11px; margin-bottom: 3px;">Cover Frame (sec)</label>
                <input id="${id('igCoverAt')}" type="number" step="0.1" min="0" placeholder="1.0" style="font-size: 12px;" />
              </div>
            </div>
            <div id="${id('igResult')}" class="hint" style="font-size: 11px; padding: 6px 10px; background: rgba(0,0,0,0.25); border-radius: 6px; min-height: 28px; display: flex; align-items: center; margin-top: auto;">Not published yet</div>
            <button id="${id('publishIgBtn')}" class="small" style="background: #e1306c; color: #fff; border-color: #e1306c; font-weight: 600; padding: 7px 12px; width: 100%;">
              📷 Publish to Instagram
            </button>
          </div>

          <!-- Card 4: TikTok -->
          <div class="conn" style="display: flex; flex-direction: column; gap: 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px;">
            <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line); padding-bottom: 8px;">
              <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-size: 16px;">🎵</span>
                <b style="font-size: 13px;">TikTok</b>
              </div>
              <span id="${id('ttBadge')}" class="pub-badge" style="font-size: 11px; padding: 2px 8px; border-radius: 10px;">Checking...</span>
            </div>
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 28px;">
              <div id="${id('ttStatus')}" class="hint" style="font-size: 11px; flex: 1;"></div>
              <div style="display: flex; gap: 6px;">
                <a id="${id('ttConnect')}" class="small btn" href="/oauth/tiktok/start" style="padding: 2px 8px; font-size: 11px;">Connect</a>
                <button id="${id('ttDisconnect')}" class="small" hidden style="padding: 2px 8px; font-size: 11px;">Disconnect</button>
              </div>
            </div>
            <div>
              <label for="${id('ttTitle')}" style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 3px;">
                <span>Caption / Title</span>
                <span id="${id('ttTitleCount')}" class="hint" style="font-size: 11px;">0/150</span>
              </label>
              <textarea id="${id('ttTitle')}" rows="3" maxlength="150" placeholder="(TikTok caption &amp; tags)" style="font-size: 12px;"></textarea>
            </div>
            <div class="row two" style="margin: 0; gap: 8px;">
              <div>
                <label for="${id('ttHashtags')}" style="font-size: 11px; margin-bottom: 3px;">Hashtags</label>
                <input id="${id('ttHashtags')}" placeholder="#fyp #viral #bangla" style="font-size: 12px;" />
              </div>
              <div>
                <label for="${id('ttPrivacy')}" style="font-size: 11px; margin-bottom: 3px;">Privacy Level</label>
                <select id="${id('ttPrivacy')}" style="font-size: 12px;">
                  <option value="PUBLIC_TO_EVERYONE">Public</option>
                  <option value="MUTUAL_FOLLOW_FRIENDS">Friends</option>
                  <option value="FOLLOWER_OF_CREATOR">Followers</option>
                  <option value="SELF_ONLY" selected>Self Only (Private)</option>
                </select>
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: 6px;">
              <label class="hint" style="margin: 0; display: inline-flex; gap: 6px; align-items: center; font-size: 11px; cursor: pointer;">
                <input type="checkbox" id="${id('ttDraft')}" style="width: auto;" />
                Save as Inbox Draft (video.upload) instead of direct publish
              </label>
            </div>
            <div id="${id('ttResult')}" class="hint" style="font-size: 11px; padding: 6px 10px; background: rgba(0,0,0,0.25); border-radius: 6px; min-height: 28px; display: flex; align-items: center; margin-top: auto;">Not published yet</div>
            <button id="${id('publishTtBtn')}" class="small" style="background: #25f4ee; color: #000; border-color: #25f4ee; font-weight: 700; padding: 7px 12px; width: 100%;">
              🎵 Publish to TikTok
            </button>
          </div>
        </div>

        <!-- Scheduled Queue Section -->
        <div style="background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px;">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <b style="font-size: 13px;">📅 Scheduled Queue</b>
              <span id="${id('queueCount')}" class="hint" style="font-size: 12px;">(0 upcoming)</span>
            </div>
            <button id="${id('queueRefreshBtn')}" class="small" type="button" style="padding: 2px 8px; font-size: 11px;">🔄 Refresh Queue</button>
          </div>
          <div id="${id('queueList')}" style="display: flex; flex-direction: column; gap: 8px;">
            <div class="hint" style="font-size: 12px; padding: 12px; text-align: center;">No scheduled posts in queue. Select "📅 Schedule for Later" above to schedule.</div>
          </div>
        </div>
      </div>
      </div>
    `;

    function log(msg, type = 'muted') {
      if (typeof options.onLog === 'function') {
        options.onLog(msg, type);
      } else {
        console.log(`[publish-box] ${msg}`);
      }
    }

    async function postJson(url, data) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        return await r.json();
      } catch (err) {
        log(`API error: ${err.message}`, 'err');
        return null;
      }
    }

    async function refresh(targetSlug) {
      if (targetSlug !== undefined) currentSlug = targetSlug;
      pubStatus = await fetch(`/api/publish/status?slug=${encodeURIComponent(currentSlug || '')}`)
        .then((r) => r.json())
        .catch(() => null);
      render();
    }

    function render() {
      const st = pubStatus;
      if (!st) return;

      // Populate reel dropdown
      const sel = $('reelSelect');
      if (sel && Array.isArray(st.reels)) {
        const prevVal = sel.value || currentSlug;
        sel.innerHTML = [
          `<option value="">(Select a reel to publish...)</option>`,
          ...st.reels.map((r) => {
            const tag = r.folder ? `[${r.folder}] ` : '';
            const status = r.hasVideo ? ' ✓' : ' (no video)';
            return `<option value="${esc(r.slug)}" ${r.slug === currentSlug ? 'selected' : ''}>${esc(tag + (r.title || r.slug))}${status}</option>`;
          }),
        ].join('');
        if (currentSlug && sel.value !== currentSlug) sel.value = currentSlug;
      }

      // Redirect URIs
      if ($('ytRedirect')) $('ytRedirect').textContent = st.youtube?.redirect || '';
      if ($('metaRedirect')) $('metaRedirect').textContent = st.meta?.redirect || '';
      if ($('tiktokRedirect')) $('tiktokRedirect').textContent = st.tiktok?.redirect || '';

      // YouTube status
      const yt = st.youtube || {};
      if (!yt.configured) {
        $('ytStatus').textContent = 'Add YOUTUBE_CLIENT_ID / SECRET in credentials above.';
        $('ytBadge').textContent = 'Not configured';
        $('ytBadge').style.background = 'rgba(248,81,73,0.15)';
        $('ytBadge').style.color = 'var(--bad)';
      } else if (!yt.connected) {
        $('ytStatus').textContent = 'Credentials ready. Click Connect to authorize channel.';
        $('ytBadge').textContent = 'Not connected';
        $('ytBadge').style.background = 'var(--panel-2)';
        $('ytBadge').style.color = 'var(--dim)';
      } else {
        $('ytStatus').textContent = `Channel: ${yt.channel?.title ?? 'Connected'}`;
        $('ytBadge').textContent = `✓ ${yt.channel?.title ?? 'Connected'}`;
        $('ytBadge').style.background = 'rgba(63,185,80,0.15)';
        $('ytBadge').style.color = 'var(--ok)';
      }
      $('ytConnect').hidden = !yt.configured || yt.connected;
      $('ytDisconnect').hidden = !yt.connected;

      // Meta status
      const m = st.meta || {};
      const page = m.pages?.find((p) => p.id === m.pageId) || m.pages?.[0];
      if (!m.configured) {
        $('metaStatus').textContent = 'Add META_APP_ID / SECRET in credentials above.';
        $('fbBadge').textContent = 'Not configured';
        $('fbBadge').style.background = 'rgba(248,81,73,0.15)';
        $('fbBadge').style.color = 'var(--bad)';
        $('igBadge').textContent = 'Not configured';
        $('igBadge').style.background = 'rgba(248,81,73,0.15)';
        $('igBadge').style.color = 'var(--bad)';
      } else if (!m.connected) {
        $('metaStatus').textContent = 'Credentials ready. Click Connect to link your Page.';
        $('fbBadge').textContent = 'Not connected';
        $('fbBadge').style.background = 'var(--panel-2)';
        $('fbBadge').style.color = 'var(--dim)';
        $('igBadge').textContent = 'Not connected';
        $('igBadge').style.background = 'var(--panel-2)';
        $('igBadge').style.color = 'var(--dim)';
      } else if (!m.pages?.length) {
        $('metaStatus').textContent = 'Connected, but account manages no Facebook Pages.';
        $('fbBadge').textContent = 'No Pages';
        $('fbBadge').style.background = 'var(--panel-2)';
        $('fbBadge').style.color = 'var(--warn)';
        $('igBadge').textContent = 'No IG';
        $('igBadge').style.background = 'var(--panel-2)';
        $('igBadge').style.color = 'var(--dim)';
      } else {
        $('metaStatus').textContent = `Page: ${page?.name ?? '?'}`;
        $('fbBadge').textContent = `✓ ${page?.name ?? 'Connected'}`;
        $('fbBadge').style.background = 'rgba(63,185,80,0.15)';
        $('fbBadge').style.color = 'var(--ok)';

        if (page?.igUserId) {
          $('igStatus').textContent = `Linked Instagram: @${page.igUsername} (via Page: ${page.name})`;
          $('igBadge').textContent = `✓ @${page.igUsername}`;
          $('igBadge').style.background = 'rgba(63,185,80,0.15)';
          $('igBadge').style.color = 'var(--ok)';
        } else {
          $('igStatus').textContent = 'No Instagram account linked to this Facebook Page.';
          $('igBadge').textContent = 'No IG linked';
          $('igBadge').style.background = 'var(--panel-2)';
          $('igBadge').style.color = 'var(--dim)';
        }
      }
      $('metaConnect').hidden = !m.configured || m.connected;
      $('metaDisconnect').hidden = !m.connected;
      $('metaPage').hidden = !(m.connected && m.pages?.length > 1);
      if (m.pages) {
        $('metaPage').innerHTML = m.pages
          .map(
            (p) =>
              `<option value="${esc(p.id)}" ${p.id === (page?.id ?? m.pageId) ? 'selected' : ''}>${esc(p.name)}${p.igUsername ? ` (+@${esc(p.igUsername)})` : ''}</option>`,
          )
          .join('');
      }

      // TikTok status
      const tt = st.tiktok || {};
      if (!tt.configured) {
        $('ttStatus').textContent = 'Add TIKTOK_CLIENT_KEY / SECRET in credentials above.';
        $('ttBadge').textContent = 'Not configured';
        $('ttBadge').style.background = 'rgba(248,81,73,0.15)';
        $('ttBadge').style.color = 'var(--bad)';
      } else if (!tt.connected) {
        $('ttStatus').textContent = 'Credentials ready. Click Connect to authorize TikTok account.';
        $('ttBadge').textContent = 'Not connected';
        $('ttBadge').style.background = 'var(--panel-2)';
        $('ttBadge').style.color = 'var(--dim)';
      } else {
        $('ttStatus').textContent = `Account: ${tt.account?.displayName ? `${tt.account.displayName} (@${tt.account.username})` : 'Connected'}`;
        $('ttBadge').textContent = `✓ ${tt.account?.username ? `@${tt.account.username}` : 'Connected'}`;
        $('ttBadge').style.background = 'rgba(63,185,80,0.15)';
        $('ttBadge').style.color = 'var(--ok)';
      }
      $('ttConnect').hidden = !tt.configured || tt.connected;
      $('ttDisconnect').hidden = !tt.connected;

      // Reel results
      const r = st.reel;
      if (!r) {
        $('globalReelHint').textContent = '— select a reel to publish';
        $('ytResult').textContent = 'Select a reel first';
        $('fbResult').textContent = 'Select a reel first';
        $('igResult').textContent = 'Select a reel first';
        $('ttResult').textContent = 'Select a reel first';
      } else if (!r.hasVideo) {
        $('globalReelHint').textContent = `— ${r.slug} (not rendered yet)`;
        $('ytResult').textContent = 'Render this reel first (no final.mp4)';
        $('fbResult').textContent = 'Render this reel first (no final.mp4)';
        $('igResult').textContent = 'Render this reel first (no final.mp4)';
        $('ttResult').textContent = 'Render this reel first (no final.mp4)';
      } else {
        $('globalReelHint').textContent = `— loaded: ${r.slug}`;
        const ytPub = r.published?.youtube;
        if (ytPub) {
          $('ytResult').innerHTML = `✓ Published (${esc(ytPub.privacy || 'public')}) · <a href="${esc(ytPub.url)}" target="_blank" style="color:var(--accent);font-weight:600">Watch Short ↗</a> · ${new Date(ytPub.at).toLocaleDateString()}`;
        } else {
          $('ytResult').textContent = yt.connected ? 'Ready to publish.' : 'Authorize YouTube channel above.';
        }

        const fbPub = r.published?.facebook;
        if (fbPub) {
          $('fbResult').innerHTML = `✓ Published · <a href="${esc(fbPub.url)}" target="_blank" style="color:var(--accent);font-weight:600">View Reel ↗</a> · ${new Date(fbPub.at).toLocaleDateString()}`;
        } else {
          $('fbResult').textContent = page ? `Ready to publish to ${page.name}.` : 'Connect Facebook Page above.';
        }

        const igPub = r.published?.instagram;
        if (igPub) {
          $('igResult').innerHTML = `✓ Published · <a href="${esc(igPub.url)}" target="_blank" style="color:var(--accent);font-weight:600">View Reel ↗</a> · ${new Date(igPub.at).toLocaleDateString()}`;
        } else {
          $('igResult').textContent = page?.igUserId ? `Ready to publish to @${page.igUsername}.` : 'Link an Instagram account to Page.';
        }

        const ttPub = r.published?.tiktok;
        if (ttPub) {
          $('ttResult').innerHTML = `✓ Published (${esc(ttPub.status || 'done')}) · <a href="${esc(ttPub.url || 'https://www.tiktok.com')}" target="_blank" style="color:var(--accent);font-weight:600">View TikTok ↗</a> · ${new Date(ttPub.at).toLocaleDateString()}`;
        } else {
          $('ttResult').textContent = tt.connected ? 'Ready to publish.' : 'Authorize TikTok account above.';
        }
      }

      // Populate post fields when slug changes
      if (r && r.slug !== lastLoadedPubSlug) {
        lastLoadedPubSlug = r.slug;
        const cfg = r.publishConfig || {};
        const txt = r.text || {};
        const defTitle = cfg.title || txt.title || '';
        const defDesc = cfg.description || txt.description || '';
        const defTags = (cfg.hashtags || txt.hashtags || []).join(' ');
        const defCover = cfg.coverAt ?? 1;

        $('ytTitle').value = cfg.youtube?.title || defTitle;
        $('ytDescription').value = cfg.youtube?.description || defDesc;
        $('ytHashtags').value = (cfg.youtube?.hashtags || []).join(' ') || defTags;
        $('ytPrivacy').value = cfg.youtube?.privacy || cfg.privacy || 'public';
        $('ytTitleCount').textContent = `${$('ytTitle').value.length}/100`;

        $('fbTitle').value = cfg.facebook?.title || defTitle;
        $('fbDescription').value = cfg.facebook?.description || defDesc;
        $('fbHashtags').value = (cfg.facebook?.hashtags || []).join(' ') || defTags;
        $('fbCoverAt').value = cfg.facebook?.coverAt ?? defCover;

        $('igDescription').value = cfg.instagram?.caption || cfg.instagram?.description || defDesc;
        $('igHashtags').value = (cfg.instagram?.hashtags || []).join(' ') || defTags;
        $('igCoverAt').value = cfg.instagram?.coverAt ?? defCover;

        $('ttTitle').value = cfg.tiktok?.title || cfg.tiktok?.description || defTitle || defDesc;
        $('ttHashtags').value = (cfg.tiktok?.hashtags || []).join(' ') || defTags;
        $('ttPrivacy').value = cfg.tiktok?.privacy || 'SELF_ONLY';
        $('ttDraft').checked = Boolean(cfg.tiktok?.draft);
        $('ttTitleCount').textContent = `${$('ttTitle').value.length}/150`;
      }

      // Button disabled states
      const canPublish = Boolean(r?.hasVideo && !busy);
      $('publishYtBtn').disabled = !canPublish || !yt.connected;
      $('publishFbBtn').disabled = !canPublish || !page;
      $('publishIgBtn').disabled = !canPublish || !page?.igUserId;
      $('publishTtBtn').disabled = !canPublish || !tt.connected;
      $('publishAllBtn').disabled = !canPublish || (!yt.connected && !page && !tt.connected);

      if (st.schedules) renderSchedules(st.schedules);
      updateStatusSummary();
    }

    function updateSchedulePreview() {
      const val = $('scheduleTime')?.value;
      if (!val) {
        $('schedulePreview').textContent = 'Select a date and time to schedule';
        $('schedulePreview').style.color = 'var(--muted)';
        return;
      }
      const target = new Date(val);
      const targetMs = target.getTime();
      if (isNaN(targetMs)) {
        $('schedulePreview').textContent = '⚠️ Invalid date or time';
        $('schedulePreview').style.color = '#ff6b6b';
        return;
      }
      if (targetMs <= Date.now() + 30000) {
        $('schedulePreview').textContent = '⚠️ Please select a future time (at least 1 min ahead)';
        $('schedulePreview').style.color = '#ff6b6b';
        return;
      }
      const formatted = target.toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
      const rel = formatRelativeTime(targetMs);
      $('schedulePreview').textContent = `📅 Scheduled for: ${formatted} (${rel})`;
      $('schedulePreview').style.color = 'var(--accent)';
    }

    function setPubMode(mode) {
      pubMode = mode;
      const isSched = mode === 'schedule';
      $('schedulePanel').hidden = !isSched;
      $('modeHint').textContent = isSched
        ? 'Queue post to automatically publish at chosen date & time'
        : 'Publish directly to connected platforms';

      if (isSched) {
        $('modeSchedBtn').style.background = 'var(--accent)';
        $('modeSchedBtn').style.color = '#0d1117';
        $('modeSchedBtn').style.fontWeight = '700';

        $('modeNowBtn').style.background = 'transparent';
        $('modeNowBtn').style.color = 'var(--muted)';
        $('modeNowBtn').style.fontWeight = '600';

        $('publishAllBtn').innerHTML = '📅 Schedule All Connected';
        $('publishYtBtn').innerHTML = '📅 Schedule YouTube';
        $('publishFbBtn').innerHTML = '📅 Schedule Facebook';
        $('publishIgBtn').innerHTML = '📅 Schedule Instagram';
        $('publishTtBtn').innerHTML = '📅 Schedule TikTok';

        if (!$('scheduleTime').value) {
          const defDate = new Date(Date.now() + 3600_000);
          $('scheduleTime').value = toDatetimeLocal(defDate);
        }
        updateSchedulePreview();
      } else {
        $('modeNowBtn').style.background = 'var(--accent)';
        $('modeNowBtn').style.color = '#0d1117';
        $('modeNowBtn').style.fontWeight = '700';

        $('modeSchedBtn').style.background = 'transparent';
        $('modeSchedBtn').style.color = 'var(--muted)';
        $('modeSchedBtn').style.fontWeight = '600';

        $('publishAllBtn').innerHTML = '🚀 Publish to All Connected';
        $('publishYtBtn').innerHTML = '▶ Publish to YouTube';
        $('publishFbBtn').innerHTML = '📘 Publish to Facebook';
        $('publishIgBtn').innerHTML = '📷 Publish to Instagram';
        $('publishTtBtn').innerHTML = '🎵 Publish to TikTok';
      }
    }

    function renderSchedules(list) {
      pubSchedules = Array.isArray(list) ? list : [];
      const pendingCount = pubSchedules.filter((s) => s.status === 'pending').length;
      $('queueCount').textContent = `(${pendingCount} pending${pubSchedules.length > pendingCount ? `, ${pubSchedules.length - pendingCount} past` : ''})`;
      updateStatusSummary();
      const qContainer = $('queueList');
      if (!qContainer) return;

      if (!pubSchedules.length) {
        qContainer.innerHTML = '<div class="hint" style="font-size: 12px; padding: 12px; text-align: center;">No scheduled posts in queue. Select "📅 Schedule for Later" above to schedule.</div>';
        return;
      }

      const sorted = [...pubSchedules].sort((a, b) => {
        if (a.status === 'pending' && b.status !== 'pending') return -1;
        if (a.status !== 'pending' && b.status === 'pending') return 1;
        if (a.status === 'pending') return a.scheduledTime - b.scheduledTime;
        return b.createdAt - a.createdAt;
      });

      qContainer.innerHTML = sorted.map((item) => {
        const plats = (item.platforms || []).map((p) => {
          const color = p === 'youtube' ? '#e62117' : p === 'facebook' ? '#1877f2' : p === 'tiktok' ? '#25f4ee' : '#e1306c';
          const icon = p === 'youtube' ? '▶' : p === 'facebook' ? '📘' : p === 'tiktok' ? '🎵' : '📷';
          return `<span style="background: ${color}22; color: ${color}; border: 1px solid ${color}66; font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 4px;">${icon} ${p}</span>`;
        }).join(' ');

        let statusBadge = '';
        if (item.status === 'pending') {
          statusBadge = '<span style="background: rgba(227,179,65,0.2); color: #e3b341; border: 1px solid rgba(227,179,65,0.4); font-size: 11px; padding: 2px 7px; border-radius: 10px; font-weight: 600;">⏳ Pending</span>';
        } else if (item.status === 'running') {
          statusBadge = '<span style="background: rgba(46,160,67,0.2); color: #3fb950; border: 1px solid rgba(46,160,67,0.4); font-size: 11px; padding: 2px 7px; border-radius: 10px; font-weight: 600;"><span class="spinner" style="width:10px;height:10px;border-width:1.5px;display:inline-block;vertical-align:middle;margin-right:4px;"></span>Running</span>';
        } else if (item.status === 'completed') {
          statusBadge = '<span style="background: rgba(46,160,67,0.2); color: #3fb950; border: 1px solid rgba(46,160,67,0.4); font-size: 11px; padding: 2px 7px; border-radius: 10px; font-weight: 600;">✓ Published</span>';
        } else if (item.status === 'failed') {
          statusBadge = '<span style="background: rgba(248,81,73,0.2); color: #f85149; border: 1px solid rgba(248,81,73,0.4); font-size: 11px; padding: 2px 7px; border-radius: 10px; font-weight: 600;">✕ Failed</span>';
        } else {
          statusBadge = `<span style="background: rgba(139,148,158,0.2); color: var(--muted); font-size: 11px; padding: 2px 7px; border-radius: 10px;">${esc(item.status)}</span>`;
        }

        const targetDate = new Date(item.scheduledAt || item.scheduledTime);
        const formatted = targetDate.toLocaleDateString(undefined, {
          weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
        });
        const rel = item.status === 'pending' ? ` · <b style="color:var(--accent)">${formatRelativeTime(item.scheduledTime)}</b>` : '';

        return `
          <div style="background: rgba(0,0,0,0.25); border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
            <div style="min-width: 240px; flex: 1;">
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 4px;">
                <b style="font-size: 13px;">${esc(item.slug)}</b>
                ${plats}
                ${statusBadge}
                ${item.nativeUpload ? '<span class="hint" style="font-size: 10px; border: 1px solid var(--line); padding: 1px 5px; border-radius: 4px;">native</span>' : ''}
              </div>
              <div class="hint" style="font-size: 11px;">
                📅 ${formatted}${rel}
                ${item.error ? `<span style="color: #ff6b6b; margin-left: 8px;">⚠️ ${esc(item.error)}</span>` : ''}
              </div>
            </div>
            <div style="display: flex; gap: 6px; align-items: center;">
              ${item.status === 'pending' ? `
                <button class="small pub-sched-run" data-id="${esc(item.id)}" style="background: var(--accent); color: #0d1117; font-weight: 600; padding: 3px 10px; font-size: 11px;">⚡ Run Now</button>
                <button class="small pub-sched-cancel" data-id="${esc(item.id)}" style="padding: 3px 8px; font-size: 11px;">✕ Cancel</button>
              ` : `
                <button class="small pub-sched-cancel" data-id="${esc(item.id)}" style="padding: 3px 8px; font-size: 11px;">✕ Dismiss</button>
              `}
            </div>
          </div>
        `;
      }).join('');

      qContainer.querySelectorAll('.pub-sched-run').forEach((b) => {
        b.onclick = async () => {
          const sId = b.getAttribute('data-id');
          log('— executing scheduled post now...', 'muted');
          await postJson('/api/publish/schedule/run-now', { id: sId });
        };
      });

      qContainer.querySelectorAll('.pub-sched-cancel').forEach((b) => {
        b.onclick = async () => {
          const sId = b.getAttribute('data-id');
          const res = await postJson('/api/publish/schedule/cancel', { id: sId });
          if (res?.schedules) renderSchedules(res.schedules);
          log('— removed schedule from queue', 'muted');
        };
      });
    }

    function collectPayload(targetPlatforms) {
      const platformData = {
        youtube: {
          title: $('ytTitle').value.trim(),
          description: $('ytDescription').value.trim(),
          hashtags: $('ytHashtags').value.trim().split(/[\s,]+/).filter(Boolean),
          privacy: $('ytPrivacy').value,
        },
        facebook: {
          title: $('fbTitle').value.trim(),
          description: $('fbDescription').value.trim(),
          hashtags: $('fbHashtags').value.trim().split(/[\s,]+/).filter(Boolean),
          coverAt: Number($('fbCoverAt').value) || 1,
        },
        instagram: {
          caption: $('igDescription').value.trim(),
          description: $('igDescription').value.trim(),
          hashtags: $('igHashtags').value.trim().split(/[\s,]+/).filter(Boolean),
          coverAt: Number($('igCoverAt').value) || 1,
        },
        tiktok: {
          title: $('ttTitle').value.trim(),
          description: $('ttTitle').value.trim(),
          hashtags: $('ttHashtags').value.trim().split(/[\s,]+/).filter(Boolean),
          privacy: $('ttPrivacy').value,
          draft: $('ttDraft').checked,
        },
      };

      const primary = targetPlatforms[0] || 'youtube';
      const pObj = platformData[primary] || platformData.youtube;
      return {
        slug: currentSlug,
        platforms: targetPlatforms,
        again: $('again').checked,
        title: pObj.title || pObj.caption || '',
        description: pObj.description || pObj.caption || '',
        hashtags: pObj.hashtags || [],
        privacy: platformData.youtube.privacy,
        coverAt: platformData.facebook.coverAt || 1,
        platformData,
      };
    }

    async function doPublish(targetPlatforms) {
      if (busy) return;
      if (!currentSlug) {
        log('— select a reel to publish first', 'err');
        return;
      }
      if (!pubStatus?.reel?.hasVideo) {
        log('— render this reel before publishing (no video)', 'err');
        return;
      }
      if (!targetPlatforms.length) {
        log('— no connected platform to publish to', 'err');
        return;
      }
      const payload = collectPayload(targetPlatforms);
      busy = true;
      log(`— publishing to ${targetPlatforms.join(', ')}...`, 'muted');
      const r = await postJson('/api/publish', payload);
      busy = false;
      if (r?.ok) {
        log(`— publishing job started for ${currentSlug}`, 'muted');
      }
    }

    async function doPublishOrSchedule(targetPlatforms) {
      if (busy) return;
      if (!currentSlug) {
        log('— select a reel to publish first', 'err');
        return;
      }
      if (!pubStatus?.reel?.hasVideo) {
        log('— render this reel before publishing (no video)', 'err');
        return;
      }
      if (!targetPlatforms.length) {
        log('— no connected platform selected', 'err');
        return;
      }

      if (pubMode === 'schedule') {
        const timeVal = $('scheduleTime').value;
        if (!timeVal) {
          log('— select a target date & time to schedule', 'err');
          return;
        }
        const targetMs = new Date(timeVal).getTime();
        if (isNaN(targetMs) || targetMs <= Date.now() + 30000) {
          log('— scheduled time must be in the future (at least 1 min)', 'err');
          return;
        }
        const payload = collectPayload(targetPlatforms);
        payload.scheduledAt = new Date(timeVal).toISOString();
        payload.nativeUpload = Boolean($('nativeUpload')?.checked);

        if (payload.nativeUpload) {
          busy = true;
          log(`— scheduling ${targetPlatforms.join(', ')} natively...`, 'muted');
          const r = await postJson('/api/publish', { ...payload, schedule: payload.scheduledAt });
          busy = false;
        } else {
          const r = await postJson('/api/publish/schedule', payload);
          if (r?.ok) {
            log(`— scheduled ${currentSlug} for ${targetPlatforms.join(', ')} at ${new Date(timeVal).toLocaleString()}`, 'muted');
            if (r.schedules) renderSchedules(r.schedules);
          }
        }
        return;
      }

      doPublish(targetPlatforms);
    }

    // Bind event handlers
    $('modeNowBtn').onclick = () => setPubMode('now');
    $('modeSchedBtn').onclick = () => setPubMode('schedule');
    $('scheduleTime').oninput = updateSchedulePreview;
    $('scheduleTime').onchange = updateSchedulePreview;

    container.querySelectorAll(`.${id('preset-btn')}`).forEach((btn) => {
      btn.onclick = () => {
        const p = btn.getAttribute('data-preset');
        const now = Date.now();
        let target = new Date(now + 3600_000);
        if (p === '30m') target = new Date(now + 30 * 60_000);
        else if (p === '1h') target = new Date(now + 60 * 60_000);
        else if (p === '3h') target = new Date(now + 180 * 60_000);
        else if (p === 'tonight8') {
          target = new Date();
          target.setHours(20, 0, 0, 0);
          if (target.getTime() <= now + 10 * 60_000) target.setDate(target.getDate() + 1);
        } else if (p === 'tomorrow10') {
          target = new Date();
          target.setDate(target.getDate() + 1);
          target.setHours(10, 0, 0, 0);
        } else if (p === 'tomorrow8') {
          target = new Date();
          target.setDate(target.getDate() + 1);
          target.setHours(20, 0, 0, 0);
        }
        $('scheduleTime').value = toDatetimeLocal(target);
        updateSchedulePreview();
      };
    });

    $('reelSelect').onchange = () => {
      const chosen = $('reelSelect').value;
      if (chosen !== currentSlug) {
        currentSlug = chosen;
        if (typeof options.onSlugChange === 'function') options.onSlugChange(chosen);
        refresh(chosen);
      }
    };

    $('saveKeysBtn').onclick = async () => {
      const keys = {};
      const val = (name) => ($(name)?.value || '').trim();
      if (val('ytClientId')) keys.YOUTUBE_CLIENT_ID = val('ytClientId');
      if (val('ytClientSecret')) keys.YOUTUBE_CLIENT_SECRET = val('ytClientSecret');
      if (val('metaAppId')) keys.META_APP_ID = val('metaAppId');
      if (val('metaAppSecret')) keys.META_APP_SECRET = val('metaAppSecret');
      if (val('tiktokClientKey')) keys.TIKTOK_CLIENT_KEY = val('tiktokClientKey');
      if (val('tiktokClientSecret')) keys.TIKTOK_CLIENT_SECRET = val('tiktokClientSecret');

      const res = await postJson('/api/save-keys', keys);
      if (res?.ok) {
        log('— credentials saved to .env', 'muted');
        refresh();
      }
    };

    $('ytDisconnect').onclick = async () => {
      await postJson('/api/publish/disconnect', { platform: 'youtube' });
      refresh();
    };

    $('metaDisconnect').onclick = async () => {
      await postJson('/api/publish/disconnect', { platform: 'meta' });
      refresh();
    };

    $('ttDisconnect').onclick = async () => {
      await postJson('/api/publish/disconnect', { platform: 'tiktok' });
      refresh();
    };

    $('metaPage').onchange = async () => {
      await postJson('/api/publish/page', { pageId: $('metaPage').value });
      refresh();
    };

    $('queueRefreshBtn').onclick = async () => {
      const s = await fetch('/api/publish/schedules').then((r) => r.json()).catch(() => []);
      renderSchedules(s);
    };

    $('publishYtBtn').onclick = () => doPublishOrSchedule(['youtube']);
    $('publishFbBtn').onclick = () => doPublishOrSchedule(['facebook']);
    $('publishIgBtn').onclick = () => doPublishOrSchedule(['instagram']);
    $('publishTtBtn').onclick = () => doPublishOrSchedule(['tiktok']);

    $('publishAllBtn').onclick = () => {
      const plats = [];
      if (pubStatus?.youtube?.connected) plats.push('youtube');
      if (pubStatus?.meta?.connected) {
        plats.push('facebook');
        const page = pubStatus.meta.pages?.find((p) => p.id === pubStatus.meta.pageId) || pubStatus.meta.pages?.[0];
        if (page?.igUserId) plats.push('instagram');
      }
      if (pubStatus?.tiktok?.connected) plats.push('tiktok');
      if (!plats.length) {
        log('— connect at least one platform first', 'err');
        return;
      }
      doPublishOrSchedule(plats);
    };

    $('autofillBtn').onclick = () => {
      const r = pubStatus?.reel;
      if (!r) {
        log('— select a reel to auto-fill captions from', 'err');
        return;
      }
      const t = r.text?.title || r.slug || '';
      const d = r.text?.description || '';
      const h = (r.text?.hashtags || []).join(' ');

      $('ytTitle').value = t.slice(0, 100);
      $('ytTitleCount').textContent = `${$('ytTitle').value.length}/100`;
      $('ytDescription').value = d;
      $('ytHashtags').value = h;

      $('fbTitle').value = t;
      $('fbDescription').value = d;
      $('fbHashtags').value = h;

      $('igDescription').value = d;
      $('igHashtags').value = h;

      $('ttTitle').value = `${t} ${h}`.trim().slice(0, 150);
      $('ttHashtags').value = h;
      $('ttTitleCount').textContent = `${$('ttTitle').value.length}/150`;

      log('— auto-filled captions and hashtags from reel text', 'muted');
    };

    $('saveDraftBtn').onclick = async () => {
      if (!currentSlug) {
        log('— select a reel first', 'err');
        return;
      }
      const payload = collectPayload([]);
      const res = await postJson('/api/publish/save', payload);
      if (res?.ok) log(`— saved draft captions for ${currentSlug}`, 'muted');
    };

    $('ytTitle').oninput = () => {
      $('ytTitleCount').textContent = `${$('ytTitle').value.length}/100`;
    };
    $('ttTitle').oninput = () => {
      $('ttTitleCount').textContent = `${$('ttTitle').value.length}/150`;
    };

    // Shared SSE event listener
    try {
      const es = new EventSource('/api/events');
      es.addEventListener('published', (e) => {
        refresh();
      });
      es.addEventListener('schedules', (e) => {
        try {
          renderSchedules(JSON.parse(e.data));
        } catch {}
      });
    } catch {}

    // Toggle state management
    const storageKey = options.storageKey || ('faceless_pub_expanded_' + (window.location.pathname.replace(/[^a-zA-Z0-9]/g, '_') || 'root'));
    const storedState = localStorage.getItem(storageKey);
    let isExpanded = storedState !== null
      ? storedState === 'true'
      : (options.defaultExpanded !== undefined ? !!options.defaultExpanded : true);

    function updateToggleUI() {
      const bodyEl = $('body');
      const topActionsEl = $('topActions');
      const toggleIcon = $('toggleIcon');
      const toggleText = $('toggleText');
      const toggleBtn = $('toggleBtn');
      const summaryEl = $('statusSummary');

      if (isExpanded) {
        if (bodyEl) bodyEl.style.display = 'flex';
        if (topActionsEl) topActionsEl.style.display = 'flex';
        if (toggleIcon) toggleIcon.textContent = '▼';
        if (toggleText) toggleText.textContent = 'Collapse';
        if (toggleBtn) {
          toggleBtn.title = 'Collapse publish studio';
          toggleBtn.style.background = 'var(--panel-2)';
          toggleBtn.style.color = 'var(--fg)';
        }
        if (summaryEl) summaryEl.style.display = 'none';
      } else {
        if (bodyEl) bodyEl.style.display = 'none';
        if (topActionsEl) topActionsEl.style.display = 'none';
        if (toggleIcon) toggleIcon.textContent = '▶';
        if (toggleText) toggleText.textContent = 'Expand';
        if (toggleBtn) {
          toggleBtn.title = 'Expand publish studio';
          toggleBtn.style.background = 'var(--accent)';
          toggleBtn.style.color = '#0d1117';
        }
        if (summaryEl) summaryEl.style.display = 'inline-flex';
      }
      updateStatusSummary();
    }

    function updateStatusSummary() {
      const summaryEl = $('statusSummary');
      if (!summaryEl) return;
      if (!pubStatus) {
        summaryEl.textContent = 'Checking platforms...';
        return;
      }
      const connected = [];
      if (pubStatus.youtube?.connected) connected.push('YouTube');
      if (pubStatus.meta?.connected) {
        if (pubStatus.meta?.hasInstagram) connected.push('FB & IG');
        else connected.push('Facebook');
      }
      if (pubStatus.tiktok?.connected) connected.push('TikTok');

      const count = connected.length;
      const pendingCount = (pubSchedules || []).filter((s) => s.status === 'pending').length;
      let text = count > 0 ? `${count} platform${count > 1 ? 's' : ''} connected (${connected.join(', ')})` : '0 platforms connected';
      if (pendingCount > 0) {
        text += ` · ⏳ ${pendingCount} scheduled`;
      }
      summaryEl.textContent = text;
      summaryEl.title = text;
    }

    function setExpanded(expand) {
      isExpanded = !!expand;
      try {
        localStorage.setItem(storageKey, String(isExpanded));
      } catch {}
      updateToggleUI();
    }

    function toggleExpanded() {
      setExpanded(!isExpanded);
    }

    if ($('toggleBtn')) $('toggleBtn').onclick = toggleExpanded;
    if ($('titleToggle')) $('titleToggle').onclick = toggleExpanded;
    updateToggleUI();

    // Initial fetch
    refresh(currentSlug);

    return {
      setSlug: (slug) => {
        if (slug !== currentSlug) {
          currentSlug = slug;
          refresh(slug);
        }
      },
      refresh: () => refresh(currentSlug),
      toggle: () => toggleExpanded(),
      expand: () => setExpanded(true),
      collapse: () => setExpanded(false),
      isExpanded: () => isExpanded,
    };
  }

  global.mountPublishBox = mountPublishBox;
})(typeof window !== 'undefined' ? window : this);

