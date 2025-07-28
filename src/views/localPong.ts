import { navigateTo } from "../router/router.js";
import { loadHtml } from "../utils/htmlLoader.js";
import { getCurrentUsername } from "../utils/jwtUtils.js";
import { Game } from "./game/Game.js";
import { GameMode, PaddleSide } from "./game/utils.js";

export async function renderPong(container: HTMLElement | null) {
  if (!container) return;

  // Fetch the component's HTML template
  container.innerHTML = await loadHtml("/html/pong.html");

  // Get the game mode from URL parameters
  const urlParams = new URLSearchParams(window.location.search);
  const gameMode = urlParams.get("mode") || "2player"; // default to 2player mode

  // Update the usernames based on game mode
  updatePlayerUsernames(gameMode);

  // Initialize the game based on the selected mode
  if (gameMode === "ai") {
    const game = new Game(GameMode.PvE, PaddleSide.Left);
    game.gameLoop();
  } else if (gameMode === "2player") {
    const game = new Game();
    game.gameLoop();
  }
}

/**
 * Update the player usernames based on game mode
 */
function updatePlayerUsernames(gameMode: string) {
  const currentUsername = getCurrentUsername();
  const player1Element = document.getElementById("player1-username");
  const player2Element = document.getElementById("player2-username");

  if (gameMode === "ai") {
    // AI vs Player mode
    if (player1Element) {
      player1Element.textContent = "AI";
    }
    if (player2Element && currentUsername) {
      player2Element.textContent = currentUsername;
    } else if (player2Element) {
      player2Element.textContent = "Guest";
    }
  } else if (gameMode === "2player") {
    // Player vs Player mode
    if (player1Element) {
      player1Element.textContent = "Player 1";
    }
    if (player2Element) {
      player2Element.textContent = "Player 2";
    }
  }
}
