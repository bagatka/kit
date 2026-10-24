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
          # No C compiler: every dependency ships built, and it is a third of the shell's download.
          default = pkgs.mkShellNoCC {
            packages = [
              # Installs packages and runs the repository's programs.
              pkgs.bun
              pkgs.git

              # Vitest and the check that npm's packages install and import run on Node: its newest
              # release, which CI's `node-version` names exactly.
              pkgs.nodejs_latest

              # The programs that capture test fixtures from other implementations, such as
              # qr-code's from qrcodegen: Python's newest release, and uv, which installs the exact
              # packages each program names.
              pkgs.python315
              pkgs.uv
            ];
          };
        }
      );

      formatter = forEachSystem (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
