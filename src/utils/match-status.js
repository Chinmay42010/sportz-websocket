import { MATCH_STATUS } from "../validation/matches.js";

/**
 * Determines a match status from its start time, end time, and the current time.
 * @param {*} startTime - The match start time.
 * @param {*} endTime - The match end time.
 * @param {Date} [now=new Date()] - The time used to evaluate the match status.
 * @returns {string|null} The scheduled, finished, or live status, or `null` if a match time is invalid.
 */
export function getMatchStatus(startTime, endTime, now = new Date()) {
  const start = new Date(startTime);
  const end = new Date(endTime);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return null;
  }

  if (now < start) {
    return MATCH_STATUS.SCHEDULED;
  }

  if (now >= end) {
    return MATCH_STATUS.FINISHED;
  }

  return MATCH_STATUS.LIVE;
}

/**
 * Synchronizes a match's status with its current time-based status.
 * @param {Object} match - The match whose status is synchronized.
 * @param {Function} updateStatus - Callback invoked with the new status.
 * @return {string|null} The match's current status.
 */
export async function syncMatchStatus(match, updateStatus) {
  const nextStatus = getMatchStatus(match.startTime, match.endTime);
  if (!nextStatus) {
    return match.status;
  }
  if (match.status !== nextStatus) {
    await updateStatus(nextStatus);
    match.status = nextStatus;
  }
  return match.status;
}
