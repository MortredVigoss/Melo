/**
 * media_api tool
 *
 * Structured music/media metadata lookup via open APIs.
 * No DRM, no scraping — clean official data.
 *
 * Supported backends (in priority order):
 *   1. MusicBrainz  — free, no API key, rate-limited to 1 req/s
 *   2. Last.fm       — free API key (config.lastFmApiKey / LASTFM_API_KEY)
 *   3. iTunes Search — free, no key, covers Apple Music catalogue
 *
 * Operations:
 *   search_track   — find a song by title + artist
 *   search_artist  — find an artist profile
 *   search_album   — find an album
 *   lookup         — direct lookup by MusicBrainz ID (MBID)
 *   similar_tracks — tracks similar to a given song (Last.fm)
 *   top_tracks     — top tracks for an artist (Last.fm)
 */

const MUSICBRAINZ_BASE = 'https://musicbrainz.org/ws/2';
const LASTFM_BASE      = 'https://ws.audioscrobbler.com/2.0';
const ITUNES_BASE      = 'https://itunes.apple.com/search';
const FETCH_TIMEOUT_MS = 15_000;

const MB_HEADERS = {
  'User-Agent': 'Melo/1.0 (https://melo.app)',
  'Accept': 'application/json',
};

// ─── MusicBrainz ─────────────────────────────────────────────────────────────

async function mbRequest(path, params, signal) {
  const url = new URL(`${MUSICBRAINZ_BASE}${path}`);
  url.searchParams.set('fmt', 'json');
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal;

  try {
    const res = await fetch(url.toString(), { signal: combined, headers: MB_HEADERS });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`MusicBrainz returned ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function mbSearchTrack(query, limit = 5, signal) {
  const data = await mbRequest('/recording', { query, limit }, signal);
  return (data.recordings || []).slice(0, limit).map(r => ({
    mbid:     r.id,
    title:    r.title,
    artist:   (r['artist-credit'] || []).map(a => a.artist?.name || a.name).join(', '),
    duration: r.length ? `${Math.floor(r.length / 60000)}m${Math.floor((r.length % 60000) / 1000)}s` : undefined,
    album:    r.releases?.[0]?.title,
    year:     r.releases?.[0]?.date?.slice(0, 4),
    score:    r.score,
  }));
}

async function mbSearchArtist(query, limit = 5, signal) {
  const data = await mbRequest('/artist', { query, limit }, signal);
  return (data.artists || []).slice(0, limit).map(a => ({
    mbid:        a.id,
    name:        a.name,
    type:        a.type,
    country:     a.country,
    begin:       a['life-span']?.begin,
    end:         a['life-span']?.end,
    tags:        (a.tags || []).slice(0, 6).map(t => t.name),
    disambiguation: a.disambiguation,
    score:       a.score,
  }));
}

async function mbSearchAlbum(query, limit = 5, signal) {
  const data = await mbRequest('/release-group', { query, limit }, signal);
  return (data['release-groups'] || []).slice(0, limit).map(rg => ({
    mbid:    rg.id,
    title:   rg.title,
    artist:  (rg['artist-credit'] || []).map(a => a.artist?.name || a.name).join(', '),
    type:    rg['primary-type'],
    year:    rg['first-release-date']?.slice(0, 4),
    score:   rg.score,
  }));
}

async function mbLookup(mbid, entity = 'recording', signal) {
  const path = `/${entity}/${mbid}`;
  const inc = entity === 'recording'
    ? 'artists releases tags'
    : entity === 'artist'
      ? 'release-groups tags'
      : 'artists';
  return mbRequest(path, { inc }, signal);
}

// ─── Last.fm ──────────────────────────────────────────────────────────────────

async function lastFmRequest(method, params, apiKey, signal) {
  const url = new URL(LASTFM_BASE);
  url.searchParams.set('method', method);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '8');
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal;

  try {
    const res = await fetch(url.toString(), { signal: combined });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Last.fm returned ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`Last.fm error ${data.error}: ${data.message}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function lfSimilarTracks(artist, track, apiKey, signal) {
  const data = await lastFmRequest('track.getSimilar', { artist, track }, apiKey, signal);
  return (data.similartracks?.track || []).slice(0, 8).map(t => ({
    title: t.name, artist: t.artist?.name, match: Number(t.match).toFixed(3),
    url: t.url,
  }));
}

async function lfTopTracks(artist, apiKey, signal) {
  const data = await lastFmRequest('artist.getTopTracks', { artist }, apiKey, signal);
  return (data.toptracks?.track || []).slice(0, 10).map(t => ({
    rank: t['@attr']?.rank, title: t.name,
    playcount: t.playcount, listeners: t.listeners,
  }));
}

async function lfTrackInfo(artist, track, apiKey, signal) {
  const data = await lastFmRequest('track.getInfo', { artist, track }, apiKey, signal);
  const t = data.track || {};
  return {
    title:       t.name,
    artist:      t.artist?.name,
    album:       t.album?.title,
    duration:    t.duration ? `${Math.floor(t.duration / 60000)}m${Math.floor((t.duration % 60000) / 1000)}s` : undefined,
    playcount:   t.playcount,
    listeners:   t.listeners,
    tags:        (t.toptags?.tag || []).map(g => g.name),
    summary:     t.wiki?.summary?.replace(/<[^>]+>/g, '').slice(0, 400),
    url:         t.url,
  };
}

// ─── iTunes Search ────────────────────────────────────────────────────────────

async function itunesSearch(term, entity = 'song', limit = 5, signal) {
  const url = new URL(ITUNES_BASE);
  url.searchParams.set('term', term);
  url.searchParams.set('entity', entity);
  url.searchParams.set('limit', String(limit));

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal;

  try {
    const res = await fetch(url.toString(), { signal: combined });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`iTunes returned ${res.status}`);
    const data = await res.json();
    return (data.results || []).slice(0, limit).map(r => ({
      trackId:    r.trackId,
      title:      r.trackName,
      artist:     r.artistName,
      album:      r.collectionName,
      genre:      r.primaryGenreName,
      duration:   r.trackTimeMillis ? `${Math.floor(r.trackTimeMillis / 60000)}m${Math.floor((r.trackTimeMillis % 60000) / 1000)}s` : undefined,
      previewUrl: r.previewUrl,   // 30s preview MP3 — no auth needed
      artworkUrl: r.artworkUrl100,
      releaseDate: r.releaseDate?.slice(0, 10),
      price:      r.trackPrice,
      currency:   r.currency,
    }));
  } finally {
    clearTimeout(timer);
  }
}

// ─── Tool definition ──────────────────────────────────────────────────────────

export const mediaApiTool = {
  id: 'media_api',
  name: 'Media API',
  description:
    'Structured music/media metadata lookup via open APIs (MusicBrainz, Last.fm, iTunes). ' +
    'Clean official data: track info, artist profiles, album details, similar tracks, top charts. ' +
    'Works without API keys (MusicBrainz + iTunes). Last.fm features require a free API key in config.',
  category: 'media',
  isConcurrencySafe: true,
  requiresPermission: false,
  parametersSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['search_track', 'search_artist', 'search_album', 'lookup', 'similar_tracks', 'top_tracks', 'track_info'],
        description:
          'search_track/artist/album — find by name. ' +
          'lookup — direct MusicBrainz ID lookup. ' +
          'similar_tracks/top_tracks/track_info — Last.fm (needs API key).',
      },
      query: {
        type: 'string',
        description: 'Search query, e.g. "周杰伦 七里香" or "Jay Chou". For "lookup", provide the MBID.',
      },
      artist: {
        type: 'string',
        description: 'Artist name (for similar_tracks, top_tracks, track_info operations).',
      },
      track: {
        type: 'string',
        description: 'Track/song title (for similar_tracks, track_info operations).',
      },
      entity: {
        type: 'string',
        enum: ['recording', 'artist', 'release-group'],
        description: 'MusicBrainz entity type for "lookup" operation.',
        default: 'recording',
      },
      backend: {
        type: 'string',
        enum: ['auto', 'musicbrainz', 'lastfm', 'itunes'],
        description: 'Force a specific backend. "auto" picks the best available.',
        default: 'auto',
      },
      limit: {
        type: 'number',
        description: 'Max results (1–10). Default: 5.',
        default: 5,
      },
    },
    required: ['operation'],
  },
  examples: [
    { operation: 'search_track', query: '七里香 周杰伦' },
    { operation: 'search_artist', query: 'Taylor Swift' },
    { operation: 'top_tracks', artist: 'Radiohead' },
    { operation: 'similar_tracks', artist: 'The Beatles', track: 'Hey Jude' },
    { operation: 'lookup', query: '5b11f4ce-a62d-471e-81fc-a69a8278c7da', entity: 'artist' },
  ],

  async run({ operation, query, artist, track, entity = 'recording', backend = 'auto', limit = 5 }, { signal, config } = {}) {
    const lim = Math.max(1, Math.min(10, Math.floor(limit) || 5));
    const lastFmKey = process.env.LASTFM_API_KEY || config?.lastFmApiKey;

    let results;
    let source = '';

    try {
      switch (operation) {
        case 'search_track': {
          if (!query) return { ok: false, output: 'query is required for search_track.', error: 'MISSING_PARAM' };
          if (backend === 'itunes' || (backend === 'auto' && !query.match(/[^\x00-\x7F]/))) {
            // iTunes handles English well; use MusicBrainz for CJK/non-ASCII
          }
          // Always try MusicBrainz first (best coverage for non-English)
          if (backend !== 'itunes') {
            results = await mbSearchTrack(query, lim, signal);
            source = 'musicbrainz';
          }
          if ((!results?.length || backend === 'itunes') && backend !== 'musicbrainz') {
            const itunesResults = await itunesSearch(query, 'song', lim, signal);
            if (itunesResults.length) { results = itunesResults; source = 'itunes'; }
          }
          break;
        }
        case 'search_artist': {
          if (!query) return { ok: false, output: 'query is required for search_artist.', error: 'MISSING_PARAM' };
          results = await mbSearchArtist(query, lim, signal);
          source = 'musicbrainz';
          break;
        }
        case 'search_album': {
          if (!query) return { ok: false, output: 'query is required for search_album.', error: 'MISSING_PARAM' };
          results = await mbSearchAlbum(query, lim, signal);
          source = 'musicbrainz';
          break;
        }
        case 'lookup': {
          if (!query) return { ok: false, output: 'query (MBID) is required for lookup.', error: 'MISSING_PARAM' };
          results = await mbLookup(query, entity, signal);
          source = 'musicbrainz';
          break;
        }
        case 'similar_tracks': {
          if (!artist || !track) return { ok: false, output: 'artist and track are required for similar_tracks.', error: 'MISSING_PARAM' };
          if (!lastFmKey) return { ok: false, output: 'similar_tracks requires a Last.fm API key. Set LASTFM_API_KEY or config.lastFmApiKey.', error: 'NO_API_KEY' };
          results = await lfSimilarTracks(artist, track, lastFmKey, signal);
          source = 'lastfm';
          break;
        }
        case 'top_tracks': {
          if (!artist) return { ok: false, output: 'artist is required for top_tracks.', error: 'MISSING_PARAM' };
          if (!lastFmKey) return { ok: false, output: 'top_tracks requires a Last.fm API key. Set LASTFM_API_KEY or config.lastFmApiKey.', error: 'NO_API_KEY' };
          results = await lfTopTracks(artist, lastFmKey, signal);
          source = 'lastfm';
          break;
        }
        case 'track_info': {
          if (!artist || !track) return { ok: false, output: 'artist and track are required for track_info.', error: 'MISSING_PARAM' };
          if (!lastFmKey) return { ok: false, output: 'track_info requires a Last.fm API key. Set LASTFM_API_KEY or config.lastFmApiKey.', error: 'NO_API_KEY' };
          results = await lfTrackInfo(artist, track, lastFmKey, signal);
          source = 'lastfm';
          break;
        }
        default:
          return { ok: false, output: `Unknown operation: ${operation}`, error: 'UNKNOWN_OP' };
      }

      if (!results || (Array.isArray(results) && !results.length)) {
        return { ok: false, output: `No results found for "${query || `${artist} - ${track}`}" via ${source}.`, error: 'NO_RESULTS' };
      }

      const output = JSON.stringify(results, null, 2);
      return {
        ok: true,
        output: `[via: media_api/${source}] ${operation} results:\n\n${output}`,
        meta: { operation, source, resultCount: Array.isArray(results) ? results.length : 1 },
      };

    } catch (err) {
      return {
        ok: false,
        output: `media_api ${operation} failed: ${err.message}`,
        error: err.message,
      };
    }
  },
};
