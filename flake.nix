{
  description = "DevShell";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-26.05";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        inherit (builtins.fromJSON (builtins.readFile ./package.json)) engines;
        sandbox = pkgs.writeShellScriptBin "sandbox" ''
          export PATH=${
            pkgs.lib.makeBinPath [
              pkgs.docker-client
              pkgs.git
              pkgs.coreutils
            ]
          }:"$PATH"
          exec ${pkgs.nushell}/bin/nu --no-config-file ${./scripts/sandbox.nu} "$@"
        '';
        defaultPackages = with pkgs; [
          deadnix
          fd
          just
          nixfmt
          nu-lint
          nushell
          ripgrep
          sandbox
          statix
          tmux
          woodpecker-cli
          mermaid-cli
          chromium
        ];
      in
      {
        devShells.default = pkgs.mkShell {
          packages = defaultPackages;

          shellHook = ''
            echo ""
            echo "  Pi Extensions Shell"
            echo "  ──────────────────────"
            echo "  nixpkgs      ${pkgs.lib.trivial.release}"
            echo "  node         ${engines.node} (docker)"
            echo "  pnpm         ${engines.pnpm} (docker)"
            echo "  bun          ${engines.bun} (docker)"
            echo ""
          '';
        };
      }
    );
}
