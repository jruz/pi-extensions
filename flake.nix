{
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
        pnpmPackage = pkgs.pnpm.override { nodejs-slim = pkgs.nodejs-slim_24; };
        mermaidFontConfig = pkgs.makeFontsConf {
          fontDirectories = [ pkgs.dejavu_fonts ];
        };
        sandboxPath = pkgs.lib.makeBinPath (
          with pkgs;
          [
            bash
            pnpmPackage
            nodejs_24
            bun
            chromium
            coreutils
            fd
            git
            gnugrep
            gnused
            just
            mermaid-cli
            nixfmt
            nushell
            statix
          ]
        );
        sandbox = pkgs.writeShellScriptBin "sandbox" ''
          SELF_DIR="$(dirname "$(readlink -f "$0")")"
          ARGS=(
            --unshare-all
            --share-net
            --die-with-parent
            --ro-bind /nix /nix
            --ro-bind /etc/resolv.conf /etc/resolv.conf
            --ro-bind /etc/ssl /etc/ssl
            --ro-bind-try /etc/static /etc/static
            --ro-bind-try /etc/nix /etc/nix
            --ro-bind-try /run/current-system/sw /run/current-system/sw
            --symlink ${pkgs.coreutils}/bin/env /usr/bin/env
            --symlink ${pkgs.bash}/bin/bash /bin/sh
            --tmpfs "$HOME"
            --tmpfs /tmp
            --bind "$(pwd)" "$(pwd)"
            --ro-bind "$(git rev-parse --path-format=absolute --git-common-dir)" "$(git rev-parse --path-format=absolute --git-common-dir)"
            --ro-bind-try "$HOME/.gitconfig" "$HOME/.gitconfig"
            --ro-bind-try "$HOME/.ssh/known_hosts" "$HOME/.ssh/known_hosts"
            --setenv PATH "${sandboxPath}:$SELF_DIR"
            --setenv HOME "$HOME"
            --setenv TMPDIR /tmp
            --dev /dev
            --proc /proc
          )
          ARGS+=(
            --bind-try "$HOME/.local/share/pnpm" "$HOME/.local/share/pnpm"
            --setenv pnpm_config_store_dir "$HOME/.local/share/pnpm/store"
            --bind-try "$HOME/.bun" "$HOME/.bun"
          )
          ARGS+=(
            --setenv FONTCONFIG_FILE "${mermaidFontConfig}"
          )
          exec ${pkgs.bubblewrap}/bin/bwrap "''${ARGS[@]}" -- "$@"
        '';
        defaultPackages = with pkgs; [
          deadnix
          fd
          just
          nixfmt
          nu-lint
          nushell
          sandbox
          statix
          tmux
          woodpecker-cli
        ];
      in
      {
        devShells.default = pkgs.mkShell {
          packages = defaultPackages;

          shellHook = ''
            echo ""
            echo "  Pi Extensions Shell"
            echo "  ───────────────────"
            echo "  nixpkgs      ${pkgs.lib.trivial.release}"
            echo "  node         ${pkgs.nodejs_24.version} (sandbox)"
            echo "  pnpm         ${pnpmPackage.version} (sandbox)"
            echo "  bun          ${pkgs.bun.version} (sandbox)"
            echo ""
          '';
        };
      }
    );
}
