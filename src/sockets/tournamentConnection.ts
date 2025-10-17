import { FastifyRequest } from "fastify";
import { WebSocket } from "ws";
import { TournamentManager } from "../tournament/TournamentManager.js";
import { TournamentPlayer } from "../tournament/TournamentState.js";
import { remoteGameRooms } from "../server.js";
import { RemoteGameRoom } from "../game/RemoteGameRoom.js";

interface TournamentMessage {
  type: string;
  data?: any;
}

interface MatchAssignment {
  gameId: number;
  room: RemoteGameRoom;
}

const matchAssignments = new Map<string, MatchAssignment>();
let nextTournamentGameId = 5000;

function buildMatchKey(tournamentId: string, matchId: string): string {
  return `${tournamentId}:${matchId}`;
}

function generateTournamentGameId(): number {
  while (remoteGameRooms.has(nextTournamentGameId)) {
    nextTournamentGameId++;
  }
  return nextTournamentGameId++;
}

/**
 * WebSocket Connection Handler for Remote Tournaments
 * Handles real-time bidirectional communication
 */
export async function handleTournamentConnection(
  ws: WebSocket,
  request: FastifyRequest<{
    Params: {
      tournamentId: string;
      username: string;
      action?: string;
    };
  }>
): Promise<void> {
  const { tournamentId, username, action } = request.params;
  const manager = TournamentManager.getInstance();

  console.log(`[Tournament WS] Connection attempt: ${username} → ${tournamentId} (${action || "join"})`);

  let playerId = username; // In production, get from auth token
  let tournament = manager.getTournament(tournamentId);

  if (!tournament) {
    ws.send(JSON.stringify({
      type: "error",
      message: "Tournament not found",
    }));
    ws.close();
    return;
  }

  // Handle reconnection
  if (action === "reconnect") {
    const result = manager.reconnectPlayer(tournamentId, playerId, ws);
    if (!result.success) {
      ws.send(JSON.stringify({
        type: "error",
        message: result.message || "Failed to reconnect",
      }));
      ws.close();
      return;
    }

    // Send current tournament state
    ws.send(JSON.stringify({
      type: "tournament:state",
      data: tournament.toJSON(),
    }));

    ws.send(JSON.stringify({
      type: "connected",
      message: "Reconnected successfully",
    }));
  } else {
    // New connection - join tournament
    const player: TournamentPlayer = {
      id: playerId,
      username: username,
      displayName: username, // In production, fetch from user service
      skill: 1000, // In production, fetch from ranking service
      joinedAt: Date.now(),
      isReady: false,
      isConnected: true,
      ws: ws,
    };

    const result = manager.joinTournament(tournamentId, player);

    if (!result.success) {
      ws.send(JSON.stringify({
        type: "error",
        message: result.message || "Failed to join tournament",
      }));
      ws.close();
      return;
    }

    // Send success message
    ws.send(JSON.stringify({
      type: "connected",
      message: "Joined tournament successfully",
    }));

    // Send initial tournament state
    ws.send(JSON.stringify({
      type: "tournament:state",
      data: tournament.toJSON(),
    }));
  }

  /**
   * Message Handler
   */
  ws.on("message", async (data: Buffer) => {
    try {
      const message: TournamentMessage = JSON.parse(data.toString());
      
      console.log(`[Tournament WS] Message from ${username}:`, message.type);

      await handleMessage(ws, message, tournamentId, playerId, manager);
    } catch (error) {
      console.error("[Tournament WS] Message handling error:", error);
      ws.send(JSON.stringify({
        type: "error",
        message: "Invalid message format",
      }));
    }
  });

  /**
   * Connection Close Handler
   */
  ws.on("close", () => {
    console.log(`[Tournament WS] Connection closed: ${username} from ${tournamentId}`);

    const tournament = manager.getTournament(tournamentId);
    if (!tournament) return;

    // If tournament hasn't started, remove player
    // If tournament is in progress, mark as disconnected (allow reconnection)
    const player = tournament.players.get(playerId);
    if (player) {
      player.isConnected = false;
      player.ws = undefined;

      if (tournament.phase === "registration") {
        manager.leaveTournament(tournamentId, playerId);
      }
    }
  });

  /**
   * Error Handler
   */
  ws.on("error", (error) => {
    console.error(`[Tournament WS] WebSocket error for ${username}:`, error);
  });
}

/**
 * Message Router
 */
async function handleMessage(
  ws: WebSocket,
  message: TournamentMessage,
  tournamentId: string,
  playerId: string,
  manager: TournamentManager
): Promise<void> {
  const tournament = manager.getTournament(tournamentId);
  if (!tournament) {
    ws.send(JSON.stringify({
      type: "error",
      message: "Tournament not found",
    }));
    return;
  }

  switch (message.type) {
    case "player:ready":
      handlePlayerReady(ws, message, tournamentId, playerId, manager);
      break;

    case "player:unready":
      ws.send(JSON.stringify({
        type: "error",
        message: "Players cannot undo ready status once confirmed",
      }));
      break;

    case "tournament:start":
      handleTournamentStart(ws, message, tournamentId, playerId, manager);
      break;

    case "match:ready":
      handleMatchReady(ws, message, tournamentId, playerId, manager);
      break;

    case "chat:message":
      handleChatMessage(ws, message, tournamentId, playerId, manager);
      break;

    case "tournament:leave":
      handleLeave(ws, message, tournamentId, playerId, manager);
      break;

    case "ping":
      ws.send(JSON.stringify({ type: "pong" }));
      break;

    default:
      ws.send(JSON.stringify({
        type: "error",
        message: `Unknown message type: ${message.type}`,
      }));
  }
}

/**
 * Message Handlers
 */
function handlePlayerReady(
  ws: WebSocket,
  message: TournamentMessage,
  tournamentId: string,
  playerId: string,
  manager: TournamentManager
): void {
  const result = manager.setPlayerReady(tournamentId, playerId, true);

  if (result.success) {
    // Broadcast to all players
    manager.broadcastToTournament(tournamentId, {
      type: "player:status",
      data: {
        playerId,
        status: "ready",
      },
    });
  } else {
    ws.send(JSON.stringify({
      type: "error",
      message: result.message,
    }));
  }
}

function handleTournamentStart(
  ws: WebSocket,
  message: TournamentMessage,
  tournamentId: string,
  playerId: string,
  manager: TournamentManager
): void {
  const tournament = manager.getTournament(tournamentId);
  if (!tournament) {
    ws.send(JSON.stringify({
      type: "error",
      message: "Tournament not found",
    }));
    return;
  }

  // Check if player is tournament creator
  if (tournament.createdBy !== playerId) {
    ws.send(JSON.stringify({
      type: "error",
      message: "Only tournament creator can start the tournament",
    }));
    return;
  }

  const canStart = tournament.canStart();
  if (!canStart.valid) {
    ws.send(JSON.stringify({
      type: "error",
      message: canStart.reason,
    }));
    return;
  }

  const started = tournament.start();
  if (started) {
    manager.broadcastToTournament(tournamentId, {
      type: "tournament:started",
      data: tournament.toJSON(),
    });
  } else {
    ws.send(JSON.stringify({
      type: "error",
      message: "Failed to start tournament",
    }));
  }
}

function handleMatchReady(
  ws: WebSocket,
  message: TournamentMessage,
  tournamentId: string,
  playerId: string,
  manager: TournamentManager
): void {
  const tournament = manager.getTournament(tournamentId);
  if (!tournament) return;

  // Get next match for player
  const match = tournament.getNextMatch(playerId);
  
  if (!match) {
    ws.send(JSON.stringify({
      type: "match:none",
      message: "No match available",
    }));
    return;
  }

  if (!match.player1 || !match.player2) {
    ws.send(JSON.stringify({
      type: "match:pending",
      message: "Waiting for opponent",
    }));
    return;
  }

  const matchKey = buildMatchKey(tournamentId, match.id);
  let assignment = matchAssignments.get(matchKey);

  if (!assignment) {
    const gameId = generateTournamentGameId();
    const room = new RemoteGameRoom(gameId, match.player1.username, {
      gameType: "tournament",
      onRoomClose: (roomId) => {
        remoteGameRooms.delete(roomId);
      },
    });
    room.player1Name = match.player1.username;
    room.player1StoredName = match.player1.username;
    room.player2Name = match.player2.username;
    room.player2StoredName = match.player2.username;

    room.onTournamentResult = ({ winnerId, score }) => {
      console.log(`[Tournament WS] Match ${match.id} completed. Winner: ${winnerId}`);
      const completion = manager.completeMatch(gameId, winnerId, score);
      if (!completion.success) {
        console.error(`[Tournament WS] Failed to complete match ${match.id}:`, completion.message);
      }
      matchAssignments.delete(matchKey);
      setTimeout(() => {
        const existingRoom = remoteGameRooms.get(gameId);
        if (existingRoom) {
          remoteGameRooms.delete(gameId);
          existingRoom.cleanup();
        }
      }, 7000);
    };

    remoteGameRooms.set(gameId, room);
    const started = manager.startMatch(tournamentId, match.id, gameId);
    if (!started.success) {
      console.error(`[Tournament WS] Failed to start match ${match.id}:`, started.message);
    }
    assignment = { gameId, room };
    matchAssignments.set(matchKey, assignment);
  }

  const side = match.player1.id === playerId ? "left" :
    match.player2.id === playerId ? "right" : null;

  if (!side) {
    ws.send(JSON.stringify({
      type: "error",
      message: "Player not part of this match",
    }));
    return;
  }

  const opponent = match.player1.id === playerId ? match.player2 : match.player1;

  ws.send(JSON.stringify({
    type: "match:assigned",
    data: {
      tournamentId,
      matchId: match.id,
      round: match.round,
      gameId: assignment.gameId,
      gameMode: "remote",
      side,
      opponent: opponent ? {
        id: opponent.id,
        username: opponent.username,
        displayName: opponent.displayName,
        avatar: opponent.avatar,
      } : null,
    },
  }));
}

function handleChatMessage(
  ws: WebSocket,
  message: TournamentMessage,
  tournamentId: string,
  playerId: string,
  manager: TournamentManager
): void {
  const tournament = manager.getTournament(tournamentId);
  if (!tournament) return;

  const player = tournament.players.get(playerId);
  if (!player) return;

  // Broadcast chat message to all players
  manager.broadcastToTournament(tournamentId, {
    type: "chat:message",
    data: {
      playerId: player.id,
      displayName: player.displayName,
      message: message.data?.text || "",
      timestamp: Date.now(),
    },
  });
}

function handleLeave(
  ws: WebSocket,
  message: TournamentMessage,
  tournamentId: string,
  playerId: string,
  manager: TournamentManager
): void {
  const result = manager.leaveTournament(tournamentId, playerId);

  if (result.success) {
    ws.send(JSON.stringify({
      type: "tournament:left",
      message: "Left tournament successfully",
    }));
    ws.close();
  } else {
    ws.send(JSON.stringify({
      type: "error",
      message: result.message,
    }));
  }
}

/**
 * Spectator Connection Handler
 */
export async function handleSpectatorConnection(
  ws: WebSocket,
  request: FastifyRequest<{
    Params: {
      tournamentId: string;
      userId: string;
    };
  }>
): Promise<void> {
  const { tournamentId, userId } = request.params;
  const manager = TournamentManager.getInstance();

  console.log(`[Spectator WS] Connection: ${userId} → ${tournamentId}`);

  const tournament = manager.getTournament(tournamentId);
  if (!tournament) {
    ws.send(JSON.stringify({
      type: "error",
      message: "Tournament not found",
    }));
    ws.close();
    return;
  }

  const result = manager.addSpectator(tournamentId, userId);
  if (!result.success) {
    ws.send(JSON.stringify({
      type: "error",
      message: result.message,
    }));
    ws.close();
    return;
  }

  // Send initial state
  ws.send(JSON.stringify({
    type: "tournament:state",
    data: tournament.toJSON(),
  }));

  ws.on("close", () => {
    manager.removeSpectator(tournamentId, userId);
  });
}
