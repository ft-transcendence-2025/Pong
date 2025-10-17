import { WebSocket } from "ws";

/**
 * Tournament Phase Lifecycle
 * REGISTRATION → READY → IN_PROGRESS → COMPLETED → ARCHIVED
 */
export enum TournamentPhase {
  REGISTRATION = "registration",
  READY = "ready",
  IN_PROGRESS = "in_progress",
  COMPLETED = "completed",
  ARCHIVED = "archived",
}

export enum MatchStatus {
  PENDING = "pending",
  IN_PROGRESS = "in_progress",
  COMPLETED = "completed",
}

export interface TournamentPlayer {
  id: string;
  username: string;
  displayName: string;
  avatar?: string;
  skill?: number;
  joinedAt: number;
  isReady: boolean;
  isConnected: boolean;
  ws?: WebSocket;
}

export interface Match {
  id: string;
  tournamentId: string;
  round: number; // 1 = semifinals, 2 = finals, 0 = third place
  position: number; // position in round
  player1?: TournamentPlayer;
  player2?: TournamentPlayer;
  winner?: TournamentPlayer;
  status: MatchStatus;
  gameId?: number;
  startedAt?: number;
  completedAt?: number;
  score?: {
    player1: number;
    player2: number;
  };
}

export interface TournamentConfig {
  maxPlayers: number;
  minPlayers: number;
  registrationTimeout: number; // ms before auto-start
  matchTimeout: number; // ms to complete a match
  isRanked: boolean;
  allowSpectators: boolean;
}

export interface TournamentBracket {
  semifinals: Match[]; // 2 matches
  finals: Match; // 1 match
  thirdPlace?: Match; // optional third place match
}

/**
 * Industry-grade Tournament State Management
 * Handles all tournament lifecycle events with immutable state updates
 */
export class TournamentState {
  public readonly id: string;
  public name: string;
  public phase: TournamentPhase;
  public config: TournamentConfig;
  public players: Map<string, TournamentPlayer>;
  public bracket: TournamentBracket | null;
  public currentRound: number;
  public spectators: Set<string>;
  public createdAt: number;
  public startedAt?: number;
  public completedAt?: number;
  public createdBy: string;
  
  private eventHandlers: Map<string, Set<(data: any) => void>>;

  constructor(
    id: string,
    name: string,
    createdBy: string,
    config?: Partial<TournamentConfig>
  ) {
    this.id = id;
    this.name = name;
    this.phase = TournamentPhase.REGISTRATION;
    this.config = {
      maxPlayers: 4,
      minPlayers: 4,
      registrationTimeout: config?.registrationTimeout || 120000, // 2 minutes
      matchTimeout: config?.matchTimeout || 600000, // 10 minutes
      isRanked: false,
      allowSpectators: false,
    };
    this.players = new Map();
    this.bracket = null;
    this.currentRound = 0;
    this.spectators = new Set();
    this.createdAt = Date.now();
    this.createdBy = createdBy;
    this.eventHandlers = new Map();
  }

  /**
   * Event system for reactive updates
   */
  public on(event: string, handler: (data: any) => void): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  public off(event: string, handler: (data: any) => void): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  private emit(event: string, data?: any): void {
    this.eventHandlers.get(event)?.forEach(handler => handler(data));
  }

  /**
   * Player Management
   */
  public addPlayer(player: TournamentPlayer): boolean {
    if (this.phase !== TournamentPhase.REGISTRATION) {
      return false;
    }

    if (this.players.size >= this.config.maxPlayers) {
      return false;
    }

    if (this.players.has(player.id)) {
      return false;
    }

    this.players.set(player.id, {
      ...player,
      joinedAt: Date.now(),
      isReady: false,
      isConnected: true,
    });

    this.emit("player:joined", player);

    // Auto-start if max players reached
    if (this.players.size === this.config.maxPlayers) {
      this.checkReadyToStart();
    }

    return true;
  }

  public removePlayer(playerId: string): boolean {
    const player = this.players.get(playerId);
    if (!player) return false;

    if (this.phase === TournamentPhase.IN_PROGRESS) {
      // Mark as disconnected but don't remove during active tournament
      player.isConnected = false;
      this.emit("player:disconnected", player);
      return true;
    }

    this.players.delete(playerId);
    this.emit("player:left", player);
    return true;
  }

  public setPlayerReady(playerId: string, ready: boolean): boolean {
    const player = this.players.get(playerId);
    if (!player || this.phase !== TournamentPhase.REGISTRATION) {
      return false;
    }

    player.isReady = ready;
    this.emit("player:ready", { player, ready });

    this.checkReadyToStart();
    return true;
  }

  public reconnectPlayer(playerId: string, ws: WebSocket): boolean {
    const player = this.players.get(playerId);
    if (!player) return false;

    player.isConnected = true;
    player.ws = ws;
    this.emit("player:reconnected", player);
    return true;
  }

  /**
   * Tournament Lifecycle
   */
  private checkReadyToStart(): void {
    if (this.phase !== TournamentPhase.REGISTRATION) return;

    const playerCount = this.players.size;
    const readyCount = Array.from(this.players.values()).filter(p => p.isReady).length;

    // All players ready and minimum met
    if (playerCount >= this.config.minPlayers && playerCount === readyCount) {
      this.setPhase(TournamentPhase.READY);
    }
  }

  public setPhase(phase: TournamentPhase): void {
    const oldPhase = this.phase;
    this.phase = phase;
    this.emit("phase:changed", { from: oldPhase, to: phase });

    if (phase === TournamentPhase.IN_PROGRESS) {
      this.startedAt = Date.now();
      this.generateBracket();
    } else if (phase === TournamentPhase.COMPLETED) {
      this.completedAt = Date.now();
    }
  }

  public start(): boolean {
    if (this.phase !== TournamentPhase.READY) {
      return false;
    }

    if (this.players.size < this.config.minPlayers) {
      return false;
    }

    this.setPhase(TournamentPhase.IN_PROGRESS);
    this.emit("tournament:started", this);
    return true;
  }

  /**
   * Bracket Generation with Skill-Based Seeding
   */
  private generateBracket(): void {
    const players = Array.from(this.players.values());

    // Sort by skill for seeding (highest skill plays lowest skill)
    players.sort((a, b) => (b.skill || 0) - (a.skill || 0));

    // Create semifinals matches
    const semifinals: Match[] = [
      {
        id: `${this.id}-sf-1`,
        tournamentId: this.id,
        round: 1,
        position: 1,
        player1: players[0],
        player2: players[3] || undefined,
        status: MatchStatus.PENDING,
      },
      {
        id: `${this.id}-sf-2`,
        tournamentId: this.id,
        round: 1,
        position: 2,
        player1: players[1] || undefined,
        player2: players[2] || undefined,
        status: MatchStatus.PENDING,
      },
    ];

    // Create finals match (winners will be filled in later)
    const finals: Match = {
      id: `${this.id}-final`,
      tournamentId: this.id,
      round: 2,
      position: 1,
      status: MatchStatus.PENDING,
    };

    // Optional third place match
    const thirdPlace: Match = {
      id: `${this.id}-3rd`,
      tournamentId: this.id,
      round: 0,
      position: 1,
      status: MatchStatus.PENDING,
    };

    this.bracket = {
      semifinals,
      finals,
      thirdPlace,
    };

    this.currentRound = 1;
    this.emit("bracket:generated", this.bracket);
  }

  /**
   * Match Management
   */
  public startMatch(matchId: string, gameId: number): boolean {
    const match = this.findMatch(matchId);
    if (!match || match.status !== MatchStatus.PENDING) {
      return false;
    }

    match.status = MatchStatus.IN_PROGRESS;
    match.gameId = gameId;
    match.startedAt = Date.now();

    this.emit("match:started", match);
    return true;
  }

  public completeMatch(matchId: string, winnerId: string, score: { player1: number; player2: number }): boolean {
    const match = this.findMatch(matchId);
    if (!match || match.status !== MatchStatus.IN_PROGRESS) {
      return false;
    }

    const winner = match.player1?.id === winnerId ? match.player1 : match.player2;
    if (!winner) return false;

    match.status = MatchStatus.COMPLETED;
    match.winner = winner;
    match.score = score;
    match.completedAt = Date.now();

    this.emit("match:completed", match);

    // Progress to next round
    this.progressBracket(match);

    return true;
  }

  private progressBracket(completedMatch: Match): void {
    if (!this.bracket || !completedMatch.winner) return;

    if (completedMatch.round === 1) {
      // Semifinals completed
      const sf1 = this.bracket.semifinals[0];
      const sf2 = this.bracket.semifinals[1];

      if (sf1.status === MatchStatus.COMPLETED && sf2.status === MatchStatus.COMPLETED) {
        // Set up finals
        this.bracket.finals.player1 = sf1.winner;
        this.bracket.finals.player2 = sf2.winner;
        this.currentRound = 2;

        // Set up third place match
        const loser1 = sf1.player1?.id === sf1.winner?.id ? sf1.player2 : sf1.player1;
        const loser2 = sf2.player1?.id === sf2.winner?.id ? sf2.player2 : sf2.player1;
        
        if (this.bracket.thirdPlace && loser1 && loser2) {
          this.bracket.thirdPlace.player1 = loser1;
          this.bracket.thirdPlace.player2 = loser2;
        }

        this.emit("round:completed", { round: 1 });
      }
    } else if (completedMatch.round === 2) {
      // Finals completed - tournament over
      this.setPhase(TournamentPhase.COMPLETED);
      this.emit("tournament:completed", {
        winner: completedMatch.winner,
        bracket: this.bracket,
      });
    }
  }

  private findMatch(matchId: string): Match | undefined {
    if (!this.bracket) return undefined;

    for (const match of this.bracket.semifinals) {
      if (match.id === matchId) return match;
    }

    if (this.bracket.finals.id === matchId) return this.bracket.finals;
    if (this.bracket.thirdPlace?.id === matchId) return this.bracket.thirdPlace;

    return undefined;
  }

  /**
   * Spectator Management
   */
  public addSpectator(userId: string): boolean {
    if (!this.config.allowSpectators) return false;
    this.spectators.add(userId);
    this.emit("spectator:joined", userId);
    return true;
  }

  public removeSpectator(userId: string): boolean {
    const removed = this.spectators.delete(userId);
    if (removed) {
      this.emit("spectator:left", userId);
    }
    return removed;
  }

  /**
   * Serialization for network transmission
   */
  public toJSON(): any {
    return {
      id: this.id,
      name: this.name,
      phase: this.phase,
      config: this.config,
      players: Array.from(this.players.values()).map(p => ({
        id: p.id,
        username: p.username,
        displayName: p.displayName,
        avatar: p.avatar,
        skill: p.skill,
        joinedAt: p.joinedAt,
        isReady: p.isReady,
        isConnected: p.isConnected,
      })),
      bracket: this.bracket,
      currentRound: this.currentRound,
      spectatorCount: this.spectators.size,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      createdBy: this.createdBy,
    };
  }

  /**
   * Validation
   */
  public canStart(): { valid: boolean; reason?: string } {
    if (this.phase !== TournamentPhase.READY) {
      return { valid: false, reason: "Tournament is not in ready phase" };
    }

    if (this.players.size < this.config.minPlayers) {
      return { valid: false, reason: `Need at least ${this.config.minPlayers} players` };
    }

    const allReady = Array.from(this.players.values()).every(p => p.isReady);
    if (!allReady) {
      return { valid: false, reason: "Not all players are ready" };
    }

    return { valid: true };
  }

  public getNextMatch(playerId: string): Match | null {
    if (!this.bracket) return null;

    // Check semifinals
    for (const match of this.bracket.semifinals) {
      if (match.status === MatchStatus.PENDING || match.status === MatchStatus.IN_PROGRESS) {
        if (match.player1?.id === playerId || match.player2?.id === playerId) {
          return match;
        }
      }
    }

    // Check finals
    if (this.bracket.finals.status === MatchStatus.PENDING || this.bracket.finals.status === MatchStatus.IN_PROGRESS) {
      if (this.bracket.finals.player1?.id === playerId || this.bracket.finals.player2?.id === playerId) {
        return this.bracket.finals;
      }
    }

    // Check third place
    if (this.bracket.thirdPlace && 
        (this.bracket.thirdPlace.status === MatchStatus.PENDING || this.bracket.thirdPlace.status === MatchStatus.IN_PROGRESS)) {
      if (this.bracket.thirdPlace.player1?.id === playerId || this.bracket.thirdPlace.player2?.id === playerId) {
        return this.bracket.thirdPlace;
      }
    }

    return null;
  }
}
