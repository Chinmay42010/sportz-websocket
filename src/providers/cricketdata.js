import "dotenv/config";

const BASE_URL = process.env.CRICKETDATA_BASE_URL || "https://api.cricapi.com/v1";
const API_KEY = process.env.CRICKETDATA_API_KEY || process.env.API_FOOTBALL_KEY;
const CRICAPI_URL = "https://api.cricapi.com/v1/currentMatches";

function inferEndTime(startIso, matchType) {
    if (!startIso) return null;
    const start = new Date(startIso);
    if (Number.isNaN(start.getTime())) return null;
    const isTest = String(matchType).toLowerCase() === "test";
    const hours = isTest ? 96 : 3; // test ~4 days, t20/odi ~3h
    return new Date(start.getTime() + hours * 60 * 60 * 1000);
}

function parseScore(r) {
    const n = Number(r);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function deriveScores(scoreArr, teams) {
    // score: [{r,w,o,inning:"Team Inning 1"}, ...]
    if (!Array.isArray(scoreArr) || scoreArr.length === 0) return { homeScore: 0, awayScore: 0 };
    if (!Array.isArray(teams) || teams.length < 2) {
        return { homeScore: parseScore(scoreArr[0]?.r), awayScore: parseScore(scoreArr[1]?.r) };
    }
    const [tA, tB] = teams;
    const aL = tA.toLowerCase(), bL = tB.toLowerCase();
    let home = 0, away = 0;
    for (let i = 0; i < scoreArr.length; i++) {
        const s = scoreArr[i];
        const inning = String(s.inning || "").toLowerCase();
        const r = parseScore(s.r);
        const hasA = inning.includes(aL);
        const hasB = inning.includes(bL);
        // ponytail: if inning mentions both/neither, fall back to index parity (home even, away odd)
        let toHome;
        if (hasA && !hasB) toHome = true;
        else if (hasB && !hasA) toHome = false;
        else toHome = (i % 2 === 0);
        if (toHome) home += r; else away += r;
    }
    return { homeScore: home, awayScore: away };
}

function deriveStatus(m) {
    if (m.matchEnded) return "finished";
    if (m.matchStarted) return "live";
    return "scheduled";
}

export function mapCricToMatch(cric) {
    const teams = Array.isArray(cric.teams) ? cric.teams : [];
    const homeTeam = teams[0] || cric.name?.split(" vs ")[0] || "TBC";
    const awayTeam = teams[1] || cric.name?.split(" vs ")[1]?.split(",")[0] || "TBC";
    const startIso = cric.dateTimeGMT ? new Date(cric.dateTimeGMT).toISOString() : new Date().toISOString();
    const endIso = inferEndTime(startIso, cric.matchType);
    const { homeScore, awayScore } = deriveScores(cric.score, teams);
    return {
        externalId: String(cric.id),
        sport: "cricket",
        homeTeam: String(homeTeam).trim(),
        awayTeam: String(awayTeam).trim(),
        status: deriveStatus(cric),
        startTime: new Date(startIso),
        endTime: endIso,
        homeScore,
        awayScore,
        raw: cric,
    };
}

export async function fetchCurrentMatches() {
    if (!API_KEY) throw new Error("CRICKETDATA_API_KEY missing (set CRICKETDATA_API_KEY or API_FOOTBALL_KEY)");
    // cricapi.com/v1/currentMatches uses GET ?apikey= , not POST
    const url = `${CRICAPI_URL}?apikey=${encodeURIComponent(API_KEY)}&offset=0`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`cricketdata fetch failed: ${res.status}`);
    const json = await res.json();
    if (json.status !== "success") throw new Error(`cricketdata api error: ${json.status} ${JSON.stringify(json.info||"")}`);
    const info = json.info || {};
    // guard: respect 100/day
    if (Number(info.hitsToday) >= 100) console.warn(`cricapi hitsToday ${info.hitsToday}/${info.hitsLimit} — defer next poll`);
    const data = Array.isArray(json.data) ? json.data : [];
    return { data, info };
}
