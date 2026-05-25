// tmux send-keys expects either literal text (-l) or symbolic key names
// ("Enter", "C-c", "Up"). When the web terminal forwards a chunk of raw input
// over WebSocket we tokenize it into runs of literal text and runs of named
// keys so each run can be issued with the right send-keys flavor.
//
// Lives in its own file (not packages/terminal/src/index.ts) because the
// project enforces an 800-line per-file ceiling — see scripts/checks/file-size.ts.

export type InputToken = { literal: boolean; value: string };

export function tokenizeTerminalInput(input: string): InputToken[] {
  const tokens: InputToken[] = [];
  let literal = "";
  const flush = () => {
    if (literal) {
      tokens.push({ literal: true, value: literal });
      literal = "";
    }
  };

  for (let index = 0; index < input.length; index += 1) {
    const rest = input.slice(index);
    const escapeKey = keyForEscapeSequence(rest);
    if (escapeKey) {
      flush();
      tokens.push({ literal: false, value: escapeKey.key });
      index += escapeKey.length - 1;
      continue;
    }

    const key = keyForControlCharacter(input[index] ?? "");
    if (key) {
      flush();
      tokens.push({ literal: false, value: key });
      continue;
    }
    literal += input[index];
  }
  flush();
  return tokens;
}

export function keyForControlCharacter(char: string): string | null {
  switch (char) {
    case "\r":
    case "\n":
      return "Enter";
    case "\t":
      return "Tab";
    case "":
      return "C-c";
    case "":
      return "C-d";
    case "":
      return "C-z";
    case "":
      return "Escape";
    case "":
      return "BSpace";
    default:
      return null;
  }
}

export function keyForEscapeSequence(input: string): { key: string; length: number } | null {
  const sequences: Record<string, string> = {
    "[A": "Up",
    "[B": "Down",
    "[C": "Right",
    "[D": "Left",
    "[H": "Home",
    "[F": "End",
    "[3~": "Delete",
    "[5~": "PageUp",
    "[6~": "PageDown",
  };
  for (const [sequence, key] of Object.entries(sequences)) {
    if (input.startsWith(sequence)) return { key, length: sequence.length };
  }
  return null;
}
