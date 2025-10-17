import { FastifyRequest, FastifyReply } from "fastify";
import {
  localTournaments, customGameRoom,
  remoteGameRooms, localGameRooms
} from "./../server.js";
import { RemoteGameRoom, CancelReason } from "./../game/RemoteGameRoom.js";
import { LocalGameRoom } from "./../game/LocalGameRoom.js";
import { LocalTournament } from "./../tournament/LocalTournament.js";
import { Players } from "./../tournament/Tournament.js";
import { tournament } from "./routes.js";
import { TournamentManager } from "./../tournament/TournamentManager.js";
import { MatchStatus } from "./../tournament/TournamentState.js";

function isSamePlayer(room: RemoteGameRoom, playerName: string): boolean {
  return room.player1StoredName === playerName || room.player2StoredName === playerName;
}

function isRoomActive(room: RemoteGameRoom): boolean {
  const state = room.game?.gameState;
  if (!state) {
    return false;
  }
  if (state.status === "cancelled") {
    return false;
  }
  if (state.score?.winner) {
    return false;
  }
  return true;
}

export function isPlayerInActiveGame(playerName: string): boolean {
  if (!playerName) {
    return false;
  }

  for (const room of remoteGameRooms.values()) {
    if (isSamePlayer(room, playerName) && isRoomActive(room)) {
      return true;
    }
  }

  for (const room of customGameRoom.values()) {
    if (isSamePlayer(room, playerName) && isRoomActive(room)) {
      return true;
    }
  }

  const tournamentManager = TournamentManager.getInstance();
  const tournament = tournamentManager.getPlayerTournament(playerName);
  if (tournament) {
    const match = tournament.getNextMatch(playerName);
    if (match && match.status === MatchStatus.IN_PROGRESS) {
      return true;
    }
  }

  return false;
}


export function joinGameRoom(reply: FastifyReply, playerName: string, playerStoredName: string): number {
  if (isPlayerInActiveGame(playerStoredName)) {
    reply.code(409).send({
      state: "busy",
      message: "Player is already participating in a game."
    });
    return -1;
  }

  for (const [id, gameRoom] of remoteGameRooms) {
    if (gameRoom.player2Name === null) {
      // Store actual username for connection matching
      gameRoom.player2Name = playerStoredName;
      gameRoom.player2StoredName = playerStoredName;
      reply.send({
        state: "joined",
        side: "right",
        gameMode: "remote",
        name: playerStoredName,  // Return actual username for WebSocket connection
        id: id,
      });
      return id;
    }
  }
  return -1;
}

export function reenterGameRoom(reply: FastifyReply, playerName: string): number {
  for (const [id, gameRoom] of remoteGameRooms) {
    // Check against stored names (actual usernames)
    if (gameRoom.player1StoredName === playerName) {
      reply.send({
        state: "enter",
        side: "left",
        gameMode: "remote",
        name: playerName,
        id: id,
      });
      return id;
    }
    else if (gameRoom.player2StoredName === playerName) {
      reply.send({
        state: "enter",
        side: "right",
        gameMode: "remote",
        name: playerName,
        id: id,
      });
      return id;
    }
  }
  return -1;
}

export function createRemoteGame(reply: FastifyReply, gameId: number, playerName: string, playerStoredName: string) {
  if (isPlayerInActiveGame(playerStoredName)) {
    reply.code(409).send({
      state: "busy",
      message: "Player is already participating in a game."
    });
    return;
  }

  const gameRoom = new RemoteGameRoom(gameId, playerStoredName, {
    gameType: "remote",
    onRoomClose: (roomId) => {
      remoteGameRooms.delete(roomId);
    },
  });
  // Store actual username for connection matching, not display name
  gameRoom.player1Name = playerStoredName;
  gameRoom.player1StoredName = playerStoredName;
  remoteGameRooms.set(gameId, gameRoom);

  reply.send({
    state: "Created",
    side: "left",
    gameMode: "remote",
    name: playerStoredName,  // Return actual username for WebSocket connection
    id: gameId,
  });
}

export function createLocalGame(reply: FastifyReply, gameId: number) {
  localGameRooms.set(gameId, new LocalGameRoom(gameId));

  reply.setCookie("localGameId", gameId.toString(), {
    path: "/",
    sameSite: "none",
    secure: true,
    httpOnly: true,
  });

  reply.send({
    state: "Created",
    gameMode: "local",
    id: gameId,
  });
}

export function createLocalTournament(req: FastifyRequest ,reply: FastifyReply, tournamentId: number) {
  const data = req.body as Players;
  const tournament = new LocalTournament(data.player1, data.player2, data.player3, data.player4, tournamentId);

  localTournaments.set(tournamentId, tournament);

  reply.setCookie("localTournamentId", JSON.stringify(tournament.state.id), {
    path: "/",
    sameSite: "none",
    secure: true,
    httpOnly: true,
  });

  reply.send(tournament.state);

}

export function createCustomGame(
  reply: FastifyReply, gameId: number,
  player1: string, player2: string,
  player1Display: string
) {
  if (isPlayerInActiveGame(player1)) {
    reply.code(409).send({
      state: "busy",
      message: "You are already participating in a game."
    });
    return;
  }

  if (isPlayerInActiveGame(player2)) {
    reply.code(409).send({
      state: "busy",
      message: "The invited player is already participating in a game."
    });
    return;
  }

  const gameRoom = new RemoteGameRoom(gameId, player1, {
    gameType: "custom",
    onRoomClose: (roomId) => {
      customGameRoom.delete(roomId);
    },
  });
  // Store actual usernames for connection matching
  gameRoom.player1Name = player1;  // Use actual username, not display name
  gameRoom.player2Name = player2;
  gameRoom.player2StoredName = player2;
  gameRoom.player1StoredName = player1;


  customGameRoom.set(gameId, gameRoom);

  reply.send({
    state: "Created",
    gameMode: "custom",
    id: gameId,
  });
}

export function cancelCustomGameRoom(gameId: number, reason: CancelReason = "invite_declined"): boolean {
  const room = customGameRoom.get(gameId);
  if (!room) {
    return false;
  }

  room.cancelGame(reason);
  return true;
}
