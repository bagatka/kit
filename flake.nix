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
          node = pkgs.nodejs_latest;

          # npm's newest release, on the Node below. Node bundles an older npm and nixpkgs has no
          # npm of its own, so it is npm's tarball from the registry, by the integrity npm publishes
          # (`npm view npm@<version> dist.integrity`); npm bundles its dependencies. CI installs the
          # same version (.github/workflows/*.yml).
          npm = pkgs.stdenvNoCC.mkDerivation rec {
            pname = "npm";
            version = "12.2.1";
            src = pkgs.fetchurl {
              url = "https://registry.npmjs.org/npm/-/npm-${version}.tgz";
              hash = "sha512-bKCmFRVT/BB+YPEYbZwQ1XUI3N5t4xKSpU1MxOjo7z3iWzKBJ0ZXRC1xFdEN+TC7N5TdywaBzf2dMXGJq/e2PQ==";
            };
            nativeBuildInputs = [ pkgs.makeWrapper ];
            dontBuild = true;
            installPhase = ''
              mkdir -p $out/lib/node_modules/npm
              cp -r . $out/lib/node_modules/npm
              makeWrapper ${node}/bin/node $out/bin/npm --add-flags $out/lib/node_modules/npm/bin/npm-cli.js
              makeWrapper ${node}/bin/node $out/bin/npx --add-flags $out/lib/node_modules/npm/bin/npx-cli.js
            '';
          };
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

              # Before Node, so its `npm` is the one found, not the one Node bundles: `npm pack` and
              # the installs of npm's packages that `bun run check` makes.
              npm

              # Vitest, and the check that npm's packages install and import, run on Node: its
              # newest release, which CI's `node-version` names exactly.
              node
            ];
          };
        }
      );

      formatter = forEachSystem (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
