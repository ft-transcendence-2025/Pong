import { TournamentState, TournamentPhase, TournamentPlayer, Match } from "./TournamentState.js";
import { WebSocket } from "ws";

/**
 * Centralized Tournament Manager
 * Handles all tournament operations with event-driven architecture
 */
export class TournamentManager {
  private tournaments: Map<string, TournamentState>;
  private playerToTournament: Map<string, string>; // playerId -> tournamentId
  private gameIdToMatch: Map<number, { tournamentId: string; matchId: string }>;
  private registrationTimers: Map<string, NodeJS.Timeout>;
  private matchTimers: Map<string, NodeJS.Timeout>;
  private registrationWarnings: Set<string>;
  
  private static instance: TournamentManager;
  private nextTournamentId: number = 1;

  private constructor() {
    this.tournaments = new Map();
    this.playerToTournament = new Map();
    this.gameIdToMatch = new Map();
    this.registrationTimers = new Map();
    this.matchTimers = new Map();
  this.registrationWarnings = new Set();

    // Start cleanup interval
    this.startCleanupInterval();
  }

  public static getInstance(): TournamentManager {
    if (!TournamentManager.instance) {
      TournamentManager.instance = new TournamentManager();
    }
    return TournamentManager.instance;
  }

  /**
   * Tournament CRUD Operations
   */
  public createTournament(
    name: string,
    createdBy: string,
    config?: any
  ): TournamentState {
    const id = `tournament-${this.nextTournamentId++}`;
    const enforcedConfig = {
      maxPlayers: 4,
      minPlayers: 4,
      registrationTimeout: config?.registrationTimeout ?? 120000,
      matchTimeout: config?.matchTimeout ?? 600000,
      isRanked: false,
      allowSpectators: false,
    };
    const tournament = new TournamentState(id, name, createdBy, enforcedConfig);

    this.tournaments.set(id, tournament);
  this.registrationWarnings.delete(id);

    // Set up event listeners
    this.setupTournamentListeners(tournament);

    // Start registration timer
    this.startRegistrationTimer(tournament);

    console.log(`[TournamentManager] Created tournament: ${id} "${name}"`);
    return tournament;
  }

  public getTournament(tournamentId: string): TournamentState | undefined {
    return this.tournaments.get(tournamentId);
  }

  public getAllTournaments(): TournamentState[] {
    return Array.from(this.tournaments.values());
  }

  public getActiveTournaments(): TournamentState[] {
    return this.getAllTournaments().filter(
      t => t.phase === TournamentPhase.REGISTRATION || 
           t.phase === TournamentPhase.READY ||
           t.phase === TournamentPhase.IN_PROGRESS
    );
  }

  public getPlayerTournament(playerId: string): TournamentState | undefined {
    const tournamentId = this.playerToTournament.get(playerId);
    return tournamentId ? this.tournaments.get(tournamentId) : undefined;
  }

  public deleteTournament(tournamentId: string): boolean {
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament) return false;

    // Clean up all associations
    tournament.players.forEach((player) => {
      this.playerToTournament.delete(player.id);
    });

    // Clear timers
    this.clearRegistrationTimer(tournamentId);
    this.clearAllMatchTimers(tournamentId);

    this.tournaments.delete(tournamentId);
    this.registrationWarnings.delete(tournamentId);
    console.log(`[TournamentManager] Deleted tournament: ${tournamentId}`);
    return true;
  }

  /**
   * Player Operations
   */
  public joinTournament(
    tournamentId: string,
    player: TournamentPlayer
  ): { success: boolean; message?: string; tournament?: TournamentState } {
    const tournament = this.tournaments.get(tournamentId);

    if (!tournament) {
      return { success: false, message: "Tournament not found" };
    }

    if (tournament.phase !== TournamentPhase.REGISTRATION) {
      return { success: false, message: "Tournament is not accepting new players" };
    }

    // Check if player is already in another tournament
    const existingTournament = this.playerToTournament.get(player.id);
    if (existingTournament && existingTournament !== tournamentId) {
      return { success: false, message: "You are already in another tournament" };
    }

    const added = tournament.addPlayer(player);
    if (!added) {
      return { success: false, message: "Could not join tournament (might be full)" };
    }

    this.playerToTournament.set(player.id, tournamentId);
    this.registrationWarnings.delete(tournamentId);
    this.broadcastTournamentState(tournament);

    return { success: true, tournament };
  }

  public leaveTournament(
    tournamentId: string,
    playerId: string
  ): { success: boolean; message?: string } {
    const tournament = this.tournaments.get(tournamentId);

    if (!tournament) {
      return { success: false, message: "Tournament not found" };
    }

    const removed = tournament.removePlayer(playerId);
    if (!removed) {
      return { success: false, message: "Could not leave tournament" };
    }

    this.playerToTournament.delete(playerId);
    this.broadcastTournamentState(tournament);

    if (playerId === tournament.createdBy) {
      this.broadcastToTournament(tournamentId, {
        type: "tournament:closed",
        data: {
          reason: "creator_left",
          message: "Tournament closed because the host left.",
          redirectTo: "/remote-tournament"
        }
      });
      this.deleteTournament(tournamentId);
      return { success: true, message: "Tournament closed by creator" };
    }

    // Delete tournament if empty and not started
    if (tournament.players.size === 0 && tournament.phase === TournamentPhase.REGISTRATION) {
      this.broadcastToTournament(tournamentId, {
        type: "tournament:closed",
        data: {
          reason: "empty",
          message: "Tournament closed because all players left.",
          redirectTo: "/remote-tournament"
        }
      });
      this.deleteTournament(tournamentId);
    }
    else if (tournament.phase === TournamentPhase.READY) {
      tournament.setPhase(TournamentPhase.REGISTRATION);
      this.registrationWarnings.delete(tournamentId);
      this.startRegistrationTimer(tournament);
    }

    return { success: true };
  }

  public setPlayerReady(
    tournamentId: string,
    playerId: string,
    ready: boolean
  ): { success: boolean; message?: string } {
    const tournament = this.tournaments.get(tournamentId);

    if (!tournament) {
      return { success: false, message: "Tournament not found" };
    }

    const updated = tournament.setPlayerReady(playerId, ready);
    if (!updated) {
      return { success: false, message: "Could not update ready status" };
    }

    this.broadcastTournamentState(tournament);
    return { success: true };
  }

  public reconnectPlayer(
    tournamentId: string,
    playerId: string,
    ws: WebSocket
  ): { success: boolean; message?: string; tournament?: TournamentState } {
    const tournament = this.tournaments.get(tournamentId);

    if (!tournament) {
      return { success: false, message: "Tournament not found" };
    }

    const reconnected = tournament.reconnectPlayer(playerId, ws);
    if (!reconnected) {
      return { success: false, message: "Could not reconnect player" };
    }

    this.broadcastTournamentState(tournament);
    return { success: true, tournament };
  }

  /**
   * Match Operations
   */
  public startMatch(
    tournamentId: string,
    matchId: string,
    gameId: number
  ): { success: boolean; message?: string; match?: Match } {
    const tournament = this.tournaments.get(tournamentId);

    if (!tournament) {
      return { success: false, message: "Tournament not found" };
    }

    const started = tournament.startMatch(matchId, gameId);
    if (!started) {
      return { success: false, message: "Could not start match" };
    }

    // Track game ID to match mapping
    this.gameIdToMatch.set(gameId, { tournamentId, matchId });

    // Start match timeout timer
    this.startMatchTimer(tournament, matchId);

    this.broadcastTournamentState(tournament);

    const match = tournament.bracket?.semifinals.find(m => m.id === matchId) ||
                  (tournament.bracket?.finals.id === matchId ? tournament.bracket.finals : undefined) ||
                  (tournament.bracket?.thirdPlace?.id === matchId ? tournament.bracket.thirdPlace : undefined);

    return { success: true, match };
  }

  public completeMatch(
    gameId: number,
    winnerId: string,
    score: { player1: number; player2: number }
  ): { success: boolean; message?: string } {
    const matchInfo = this.gameIdToMatch.get(gameId);

    if (!matchInfo) {
      return { success: false, message: "Match not found for game" };
    }

    const tournament = this.tournaments.get(matchInfo.tournamentId);
    if (!tournament) {
      return { success: false, message: "Tournament not found" };
    }

    const completed = tournament.completeMatch(matchInfo.matchId, winnerId, score);
    if (!completed) {
      return { success: false, message: "Could not complete match" };
    }

    // Clear match timer
    this.clearMatchTimer(matchInfo.matchId);

    // Remove game ID mapping
    this.gameIdToMatch.delete(gameId);

    this.broadcastTournamentState(tournament);

    return { success: true };
  }

  /**
   * Spectator Operations
   */
  public addSpectator(
    tournamentId: string,
    userId: string
  ): { success: boolean; message?: string } {
    const tournament = this.tournaments.get(tournamentId);

    if (!tournament) {
      return { success: false, message: "Tournament not found" };
    }

    const added = tournament.addSpectator(userId);
    if (!added) {
      return { success: false, message: "Spectators not allowed for this tournament" };
    }

    return { success: true };
  }

  public removeSpectator(
    tournamentId: string,
    userId: string
  ): { success: boolean; message?: string } {
    const tournament = this.tournaments.get(tournamentId);

    if (!tournament) {
      return { success: false, message: "Tournament not found" };
    }

    tournament.removeSpectator(userId);
    return { success: true };
  }

  /**
   * Event Listeners
   */
  private setupTournamentListeners(tournament: TournamentState): void {
    tournament.on("phase:changed", ({ from, to }) => {
      console.log(`[TournamentManager] Tournament ${tournament.id} phase: ${from} → ${to}`);
      
      if (to === TournamentPhase.READY) {
        this.clearRegistrationTimer(tournament.id);
      } else if (to === TournamentPhase.IN_PROGRESS) {
        // Tournament started
        console.log(`[TournamentManager] Tournament ${tournament.id} started with ${tournament.players.size} players`);
      } else if (to === TournamentPhase.COMPLETED) {
        // Tournament finished
        console.log(`[TournamentManager] Tournament ${tournament.id} completed`);
        this.handleTournamentCompleted(tournament);
      }

      this.broadcastTournamentState(tournament);
    });

    tournament.on("player:joined", (player) => {
      console.log(`[TournamentManager] Player ${player.displayName} joined tournament ${tournament.id}`);
    });

    tournament.on("player:left", (player) => {
      console.log(`[TournamentManager] Player ${player.displayName} left tournament ${tournament.id}`);
    });

    tournament.on("match:started", (match) => {
      console.log(`[TournamentManager] Match ${match.id} started in tournament ${tournament.id}`);
    });

    tournament.on("match:completed", (match) => {
      console.log(`[TournamentManager] Match ${match.id} completed. Winner: ${match.winner?.displayName}`);
    });

    tournament.on("tournament:completed", ({ winner }) => {
      console.log(`[TournamentManager] Tournament ${tournament.id} won by ${winner.displayName}`);
    });
  }

  /**
   * Broadcasting
   */
  private broadcastTournamentState(tournament: TournamentState): void {
    const state = tournament.toJSON();
    const message = JSON.stringify({
      type: "tournament:state",
      data: state,
    });

    // Broadcast to all players
    tournament.players.forEach((player) => {
      if (player.ws && player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(message);
      }
    });

    // Broadcast to spectators (if you track their WebSockets)
    // For now, spectators would need to poll or use a separate mechanism
  }

  public broadcastToTournament(
    tournamentId: string,
    message: any,
    excludePlayerId?: string
  ): void {
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament) return;

    const data = JSON.stringify(message);
    tournament.players.forEach((player) => {
      if (player.id !== excludePlayerId && player.ws && player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(data);
      }
    });
  }

  /**
   * Timers
   */
  private startRegistrationTimer(tournament: TournamentState): void {
    this.clearRegistrationTimer(tournament.id);
    const timer = setTimeout(() => {
      console.log(`[TournamentManager] Registration timeout for tournament ${tournament.id}`);

      if (tournament.phase === TournamentPhase.REGISTRATION) {
        if (tournament.players.size >= tournament.config.minPlayers) {
          tournament.players.forEach((player) => {
            tournament.setPlayerReady(player.id, true);
          });
          tournament.start();
          this.registrationWarnings.delete(tournament.id);
        } else {
          if (tournament.players.size === 0) {
            console.log(`[TournamentManager] Tournament ${tournament.id} removed - empty after timeout`);
            this.broadcastToTournament(tournament.id, {
              type: "tournament:closed",
              data: {
                reason: "empty",
                message: "Tournament closed because all players left.",
                redirectTo: "/remote-tournament"
              }
            });
            this.deleteTournament(tournament.id);
            return;
          }

          const hasWarned = this.registrationWarnings.has(tournament.id);
          if (!hasWarned) {
            this.registrationWarnings.add(tournament.id);
            this.broadcastToTournament(tournament.id, {
              type: "tournament:registration_timeout",
              data: {
                message: "Not enough players joined yet. Keep the tournament open?",
                waitingFor: Math.max(0, tournament.config.minPlayers - tournament.players.size)
              }
            });

            // Reschedule to check again after the same timeout window
            this.startRegistrationTimer(tournament);
          } else {
            this.broadcastToTournament(tournament.id, {
              type: "tournament:registration_timeout",
              data: {
                message: "Still waiting for more players to join the bracket.",
                waitingFor: Math.max(0, tournament.config.minPlayers - tournament.players.size)
              }
            });
            this.startRegistrationTimer(tournament);
          }
        }
      }
    }, tournament.config.registrationTimeout);

    this.registrationTimers.set(tournament.id, timer);
  }

  private clearRegistrationTimer(tournamentId: string): void {
    const timer = this.registrationTimers.get(tournamentId);
    if (timer) {
      clearTimeout(timer);
      this.registrationTimers.delete(tournamentId);
    }
  }

  private startMatchTimer(tournament: TournamentState, matchId: string): void {
    const timer = setTimeout(() => {
      console.log(`[TournamentManager] Match ${matchId} timeout`);
      // Handle match timeout (e.g., forfeit, assign default winner)
      // Implementation depends on your requirements
    }, tournament.config.matchTimeout);

    this.matchTimers.set(matchId, timer);
  }

  private clearMatchTimer(matchId: string): void {
    const timer = this.matchTimers.get(matchId);
    if (timer) {
      clearTimeout(timer);
      this.matchTimers.delete(matchId);
    }
  }

  private clearAllMatchTimers(tournamentId: string): void {
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament || !tournament.bracket) return;

    tournament.bracket.semifinals.forEach((match) => {
      this.clearMatchTimer(match.id);
    });
    this.clearMatchTimer(tournament.bracket.finals.id);
    if (tournament.bracket.thirdPlace) {
      this.clearMatchTimer(tournament.bracket.thirdPlace.id);
    }
  }

  /**
   * Cleanup
   */
  private handleTournamentCompleted(tournament: TournamentState): void {
    // Clear all timers
    this.clearRegistrationTimer(tournament.id);
    this.clearAllMatchTimers(tournament.id);

    // Archive after some time
    setTimeout(() => {
      tournament.setPhase(TournamentPhase.ARCHIVED);
      
      // Optionally delete after archival
      setTimeout(() => {
        this.deleteTournament(tournament.id);
      }, 300000); // 5 minutes after archival
    }, 60000); // 1 minute after completion
  }

  private startCleanupInterval(): void {
    // Clean up archived tournaments every 10 minutes
    setInterval(() => {
      const now = Date.now();
      this.tournaments.forEach((tournament, id) => {
        if (tournament.phase === TournamentPhase.ARCHIVED) {
          const timeSinceCompletion = now - (tournament.completedAt || 0);
          if (timeSinceCompletion > 600000) { // 10 minutes
            this.deleteTournament(id);
          }
        }
      });
    }, 600000); // Every 10 minutes
  }

  /**
   * Shutdown
   */
  public shutdown(): void {
    console.log("[TournamentManager] Shutting down...");

    // Clear all timers
    this.registrationTimers.forEach((timer) => clearTimeout(timer));
    this.matchTimers.forEach((timer) => clearTimeout(timer));

    // Close all WebSocket connections
    this.tournaments.forEach((tournament) => {
      tournament.players.forEach((player) => {
        if (player.ws) {
          player.ws.close();
        }
      });
    });

    this.tournaments.clear();
    this.playerToTournament.clear();
    this.gameIdToMatch.clear();
    this.registrationTimers.clear();
    this.matchTimers.clear();

    console.log("[TournamentManager] Shutdown complete");
  }

  /**
   * Statistics
   */
  public getStats(): any {
    return {
      totalTournaments: this.tournaments.size,
      activeTournaments: this.getActiveTournaments().length,
      totalPlayers: this.playerToTournament.size,
      activeMatches: this.gameIdToMatch.size,
    };
  }
}
