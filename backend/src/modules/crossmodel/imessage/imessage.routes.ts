/**
 * iMessage Agent Routes
 *
 * Mounted under /api/crossmodel/imessage by crossmodel.routes.ts, BEFORE the global
 * authenticate middleware — because the agent's pairing + transport endpoints carry
 * no JWT (they authenticate with the agent bearer token instead). User-facing routes
 * apply `authenticate` individually.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../../../middleware/auth';
import controller from './imessage.controller';
import relayOperatorController from './relay-operator.controller';
import { resolveAgentByToken } from './imessage.service';

const router = Router();

/** Authenticate a request from the macOS agent via its bearer token. */
async function authenticateAgent(req: Request, res: Response, next: NextFunction) {
  const headerToken = (req.headers['x-agent-token'] as string) || '';
  const authz = req.headers.authorization || '';
  const bearer = authz.startsWith('Bearer ') ? authz.slice(7) : '';
  const token = headerToken || bearer;

  if (!token) {
    res.status(401).json({ error: 'Missing agent token' });
    return;
  }
  const agent = await resolveAgentByToken(token);
  if (!agent) {
    res.status(401).json({ error: 'Invalid agent token' });
    return;
  }
  (req as any).agent = agent;
  next();
}

// ── Agent transport (agent-token auth) ──────────────────────────────────────────
router.post('/pair/complete', (req, res, next) => controller.completePair(req, res, next));
router.get('/agent/poll', authenticateAgent, (req, res) => controller.agentPoll(req, res));
router.post('/agent/result', authenticateAgent, (req, res) => controller.agentResult(req, res));
// RELAY DATA PLANE — the DEVICE half (ticket c468f922, owner ruling
// 2026-10-29/30). These are the device's dial-OUT: it polls us, we never dial
// it, and no inbound port exists on the Mac/PC. Agent-token auth like the poll
// above; the session is resolved FROM the device's own grant, never named by
// it. Registered before the JWT routes so an agent request can never be asked
// for a user token.
router.get('/agent/relay/frames', authenticateAgent, (req, res, next) => controller.agentGetRelayFrames(req as any, res, next));
router.post('/agent/relay/frames', authenticateAgent, (req, res, next) => controller.agentPostRelayFrame(req as any, res, next));

// ── Web UI (JWT auth) ─────────────────────────────────────────────────────────
router.post('/pair/start', authenticate, (req, res, next) => controller.startPair(req, res, next));
router.get('/status', authenticate, (req, res, next) => controller.getStatus(req, res, next));
router.get('/agents', authenticate, (req, res, next) => controller.listAgents(req, res, next));
// Multi-Mac device management (owner 2026-09-24): per-device unpair / rename /
// make-default. `authenticate` middleware scopes every handler to req.user.id —
// the service layer additionally filters rows by { id, userId } so a forged id
// can never touch another user's Mac.
router.delete('/agents/:id', authenticate, (req, res, next) => controller.deleteAgent(req, res, next));
router.patch('/agents/:id', authenticate, (req, res, next) => controller.renameAgent(req, res, next));
router.post('/agents/:id/default', authenticate, (req, res, next) => controller.setDefaultAgent(req, res, next));
// Permission onboarding buttons (ticket 2f646c10, agent ≥ 0.6.0): relaunch the
// helper (post-update TCC self-heal), open a Privacy & Security pane, or reveal
// the DigbyHelper binary in Finder.
router.post('/agents/:id/permission-action', authenticate, (req, res, next) => controller.permissionAction(req, res, next));
// BROKERED OPERATOR SESSION (ticket c468f922, owner ruling 2026-10-29 — the
// "strong per-session auth" property): open / use-once / close a time-boxed
// session bound to ONE device. Same `authenticate` + per-row userId scoping as
// the device-management routes above, so a forged id can never touch another
// user's Mac. Open is additionally gated on the remote-access verdict being
// `ready`, so a session cannot be minted onto an exposed or half-configured
// channel. The USE verb is what makes `stale` reachable: without a producer the
// Redis key the verdict reader consults was never written by anything.
router.post('/agents/:id/brokered-session', authenticate, (req, res, next) => controller.openBrokeredSession(req, res, next));
router.post('/agents/:id/brokered-session/use', authenticate, (req, res, next) => controller.useBrokeredSession(req, res, next));
router.delete('/agents/:id/brokered-session', authenticate, (req, res, next) => controller.closeBrokeredSession(req, res, next));
// RELAY DATA PLANE — the OPERATOR half (ticket c468f922, owner ruling
// 2026-10-29/30): send / drain one session's frames. Same `authenticate` + the
// per-row userId scoping as the grant verbs above, PLUS the session capability
// minted when the session was opened — a sessionId alone never carries traffic,
// because a JWT outlives any one session while a capability does not.
router.post('/agents/:id/relay/frames', authenticate, (req, res, next) => controller.postRelayFrame(req, res, next));
router.get('/agents/:id/relay/frames', authenticate, (req, res, next) => controller.getRelayFrames(req, res, next));
// OPERATOR-SIDE RENDERER (ticket c468f922) — the surface that turns carried
// bytes back into something the operator can look at and act on. The two
// verbs above CARRY a session; these two RENDER it (`…/relay/screen`) and
// drive it (`…/relay/input`). Same `authenticate` + per-row userId scoping and
// the same per-session capability in the x-session-capability header.
//
// Kept in a separate controller module (relay-operator.controller.ts) because
// `agent-derail-break.9cc62eef.test.ts` pins ABSOLUTE line windows of
// imessage.controller.ts; see that module's header.
router.get('/agents/:id/relay/screen', authenticate, (req, res, next) => relayOperatorController.getScreen(req, res, next));
router.post('/agents/:id/relay/input', authenticate, (req, res, next) => relayOperatorController.postInput(req, res, next));
router.delete('/disconnect', authenticate, (req, res, next) => controller.disconnect(req, res, next));
router.get('/chats', authenticate, (req, res) => controller.getChats(req, res));
router.get('/messages', authenticate, (req, res) => controller.getMessages(req, res));
router.post('/send', authenticate, (req, res) => controller.send(req, res));
// E5 (2026-09-25): the confirm card's Cancel labels the parked imessage_send
// decision (telemetry only; Send labels it inside /send via body.decisionId).
router.post('/draft-outcome', authenticate, (req, res) => controller.draftOutcome(req, res));

export default router;
