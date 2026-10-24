{
  description = "bagatka/kit development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs =
    { nixpkgs, ... }:
    let
      supportedSystems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];

      forEachSystem = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      devShells = forEachSystem (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          # Only what `bun run check`, `bun run test` and `bun run build` run, as the shell is every
          # orb's download. No C compiler: every dependency ships built, and it was a third of it.
          # No Git: every machine that cloned the repository has one, and nothing needs a pinned
          # version; Nix's Git brings Perl, almost half the shell. No Python or uv: they only run
          # programs that capture test fixtures by hand, such as qr-code's, which say how.
          default = pkgs.mkShellNoCC {
            packages = [
              # Installs packages and runs the repository's programs.
              pkgs.bun

              # Vitest, `npm pack`, and the check that npm's packages install and import run on
              # Node: its newest release, which CI's `node-version` names exactly.
              pkgs.nodejs_latest
            ];
          };
        }
      );

      formatter = forEachSystem (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
