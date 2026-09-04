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
    return json;
}

export function parseCricbuzzLive(json) {
    const out = [];
    const typeMatches = Array.isArray(json.typeMatches) ? json.typeMatches : [];
    for (const tm of typeMatches) {
        const seriesMatches = Array.isArray(tm.seriesMatches) ? tm.seriesMatches : [];
        for (const sm of seriesMatches) {
            const wrapper = sm.seriesAdWrapper;
            if (!wrapper || !Array.isArray(wrapper.matches)) continue;
            for (const m of wrapper.matches) {
                const info = m.matchInfo;
                const score = m.matchScore;
                if (!info || !info.matchId) continue;
                const t1 = info.team1?.teamSName || info.team1?.teamName || "";
                const t2 = info.team2?.teamSName || info.team2?.teamName || "";
                const s1 = score?.team1Score?.inngs1, s2 = score?.team2Score?.inngs1;
                out.push({
                    id: String(info.matchId),
                    name: `${info.team1?.teamName || t1} vs ${info.team2?.teamName || t2}`,
                    teams: [info.team1?.teamName || t1, info.team2?.teamName || t2],
                    shortTeams: [t1, t2],
                    matchType: info.matchFormat || "t20",
                    status: info.status || info.state || "",
                    state: info.state || "",
                    stateTitle: info.stateTitle || "",
                    venue: info.venueInfo?.ground || "",
                    dateTimeGMT: info.startDate ? new Date(Number(info.startDate)).toISOString() : new Date().toISOString(),
                    score: [
                        ...(s1 ? [{ r: s1.runs, w: s1.wickets, o: s1.overs, inning: `${t1} Inning 1` }] : []),
                        ...(s2 ? [{ r: s2.runs, w: s2.wickets, o: s2.overs, inning: `${t2} Inning 1` }] : []),
                    ],
                    series_id: String(info.seriesId || ""),
                    matchStarted: info.state !== "Upcoming",
                    matchEnded: info.stateTitle === "Complete" || info.state === "Complete",
                    raw: m,
                });
            }
        }
    }
    return out;
}

export function mapCricbuzzLiveToMatch(c) {
    const teams = c.teams;
    const homeTeam = teams[0] || c.name?.split(" vs ")[0] || "TBC";
    const awayTeam = teams[1] || c.name?.split(" vs ")[1]?.split(",")[0] || "TBC";
    const start = c.dateTimeGMT ? new Date(c.dateTimeGMT) : new Date();
    const isTest = String(c.matchType).toLowerCase() === "test";
    const end = new Date(start.getTime() + (isTest ? 96 : 3) * 60 * 60 * 1000);
    const homeScore = Number(c.score?.[0]?.r ?? 0);
    const awayScore = Number(c.score?.[1]?.r ?? 0);
    const status = c.matchEnded ? "finished" : c.matchStarted ? "live" : "scheduled";
    return {
        externalId: `cb-${c.id}`,
        sport: "cricket",
        homeTeam: String(homeTeam).trim(),
        awayTeam: String(awayTeam).trim(),
        status,
        startTime: start,
        endTime: end,
        homeScore,
        awayScore,
        raw: c,
    };
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
