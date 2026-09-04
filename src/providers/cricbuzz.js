import "dotenv/config";

const RAPID_KEY = process.env.CRICBUZZ_API_KEY || process.env.CRICBUZZ_RAPIDAPI_KEY || process.env.CRICDATA_API_KEY;
const RAPID_HOST = process.env.CRICBUZZ_HOST || "cricbuzz-cricket.p.rapidapi.com";
const BASE = `https://${RAPID_HOST}`;

function headers() {
    if (!RAPID_KEY) throw new Error("CRICBUZZ_API_KEY missing (set CRICBUZZ_API_KEY or CRICDATA_API_KEY)");
    return {
        "X-RapidAPI-Key": RAPID_KEY,
        "X-RapidAPI-Host": RAPID_HOST,
        accept: "application/json",
    };
}

export async function fetchCricbuzzLiveMatches() {
    const url = `${BASE}/matches/v1/live`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) throw new Error(`cricbuzz live failed: ${res.status}`);
    const json = await res.json();
    // response is {typeMatches:[{matchDetailsMap}], adWrapper ...} or {matches}
    return json;
}

export async function fetchCricbuzzScorecard(matchId) {
    // playground: /mcenter/v1/{id}/hscard
    const url = `${BASE}/mcenter/v1/${encodeURIComponent(matchId)}/hscard`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) throw new Error(`cricbuzz hscard ${matchId} failed: ${res.status}`);
    return await res.json();
}

// Mapper for scorecard JSON you pasted: {scorecard:[{inningsid,batsman[],bowler[],score,wickets,overs,runrate,batteamname,fow,extras}]}
export function mapCricbuzzScorecard(json) {
    const sc = Array.isArray(json.scorecard) ? json.scorecard : [];
    return sc.map(inn => ({
        inningsId: inn.inningsid,
        batTeam: inn.batteamname || inn.batteamSName || inn.batteamsname || "",
        score: inn.score ?? 0,
        wickets: inn.wickets ?? 0,
        overs: inn.overs ?? 0,
        runRate: inn.runrate ?? null,
        extras: inn.extras || null,
        fow: inn.fow?.fow || [],
        batsman: (inn.batsman || []).map(b => ({
            id: b.id, name: b.name, runs: b.runs, balls: b.balls, fours: b.fours, sixes: b.sixes, sr: b.strkrate, out: b.outdec, isCaptain: b.iscaptain, isKeeper: b.iskeeper,
        })),
        bowler: (inn.bowler || []).map(b => ({
            id: b.id, name: b.name, overs: b.overs, maidens: b.maidens, wickets: b.wickets, runs: b.runs, economy: b.economy,
        })),
    }));
}
