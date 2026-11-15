module log {
    export def error [msg: string]: nothing -> nothing {
        print --stderr $"[(ansi red)ERROR(ansi reset)] ($msg)"
    }

    export def ok [msg: string]: nothing -> nothing {
        print --stderr $"[(ansi green)OK(ansi reset)] ($msg)"
    }
}

use log

const CONFIG_TYPES = {
    readonlyHomeDirectories: list<string>
    agerManifest: string
}

const RUNTIME_COMMANDS = {
    bun: [bun]
    node: [node pnpm]
    rust: [cargo cargo-* rustc rustup rustfmt rust-analyzer sqlx]
}

const BUILT_RUNTIMES = [node rust]

def known-commands []: nothing -> list<string> {
    $RUNTIME_COMMANDS | values | flatten
}

def help-text []: nothing -> string {
    let runtimes = ($RUNTIME_COMMANDS
        | items {|runtime, commands| $"  ($runtime): ($commands | str join ', ')" }
        | str join "\n")
    [
        "Run a command inside its runtime container."
        ""
        "Usage:"
        "  sandbox <command> [...args]  run a command in its runtime container"
        "  sandbox build [--force]      build missing images for existing Dockerfiles, --force rebuilds all"
        "  sandbox --help               show this help"
        ""
        "Commands:"
        $runtimes
    ] | str join "\n"
}

def matches-pattern [pattern: string]: string -> bool {
    $in =~ $"^($pattern | str replace --all '*' '.*')$"
}

def runtimes-of [command: string]: nothing -> list<string> {
    ($RUNTIME_COMMANDS
        | transpose runtime commands
        | where ($it.commands | any {|pattern| $command | matches-pattern $pattern })
        | get runtime)
}

def is-known [command: string]: nothing -> bool {
    runtimes-of $command | is-not-empty
}

def runtime-of [command: string]: nothing -> string {
    runtimes-of $command | first
}

def unknown-command-text [command: string]: nothing -> string {
    $"sandbox: unknown command: ($command)\nknown commands: (known-commands | str join ', ')"
}

def repo-root []: nothing -> path {
    ^git rev-parse --show-toplevel | str trim
}

def dockerfile-path [root: path, name: string]: nothing -> path {
    $root | path join $"Dockerfile.($name)"
}

def image-tag [dockerfile: string, config: record]: nothing -> string {
    let key = ([$dockerfile $config.build_args]
        | to json --raw
        | hash sha256
        | str substring 0..15)
    $"sandbox-($config.name):($key)"
}

def image-exists [image: string]: nothing -> bool {
    let lookup = (^docker image ls --quiet --filter $"reference=($image)")
    $lookup | str trim | is-not-empty
}

def build-image []: record -> nothing {
    let spec = $in
    let args = ($spec.build_args
        | items {|name, value| [--build-arg $"($name)=($value)"] }
        | flatten)
    $spec.dockerfile | ^docker build --tag $spec.image ...$args -
}

def image-spec [root: path]: record -> record {
    let config = $in
    let dockerfile = (open --raw (dockerfile-path $root $config.name))
    {
        image: (image-tag $dockerfile $config)
        dockerfile: $dockerfile
        build_args: $config.build_args
    }
}

def ensure-image []: record -> nothing {
    let spec = $in
    if not (image-exists $spec.image) {
        $spec | build-image
    }
}

def image-config [root: path, runtime: string]: nothing -> record {
    match $runtime {
        node => {
            let engines = (open ($root | path join package.json) | get engines)
            {
                name: node
                build_args: {
                    NODE_VERSION: $engines.node
                    PNPM_VERSION: $engines.pnpm
                }
            }
        }
        rust => {
            let version = (open ($root | path join rust-toolchain.toml) | get toolchain.channel)
            {
                name: rust
                build_args: {RUST_VERSION: $version}
            }
        }
    }
}

def runtime-image [root: path, runtime: string]: nothing -> string {
    match $runtime {
        bun => {
            let version = (open ($root | path join package.json) | get engines.bun)
            $"oven/bun:($version)"
        }
        _ => {
            let spec = (image-config $root $runtime | image-spec $root)
            $spec | ensure-image
            $spec.image
        }
    }
}

def pnpm-store []: nothing -> path {
    $env.HOME | path join .local share pnpm
}

def pnpm-cache []: nothing -> path {
    $env.HOME | path join .cache pnpm
}

def cache-dirs [runtime: string]: nothing -> list<path> {
    match $runtime {
        bun => []
        node => [(pnpm-store) (pnpm-cache)]
        rust => [($env.HOME | path join .cargo registry) ($env.HOME | path join .cargo git)]
    }
}

def runtime-env [runtime: string]: nothing -> list<string> {
    match $runtime {
        bun => []
        node => [
            --env $"pnpm_config_store_dir=(pnpm-store)/store"
            --env $"pnpm_config_cache_dir=(pnpm-cache)"
        ]
        rust => [
            --env $"CARGO_HOME=($env.HOME)/.cargo"
            --env CARGO_TARGET_DIR=/app/target/docker
        ]
    }
}

def create-dirs []: list<path> -> list<path> {
    let directories = $in
    for directory in $directories {
        mkdir $directory
    }
    $directories
}

def bind-mounts [--readonly]: list<path> -> list<string> {
    let suffix = if $readonly { ",readonly" } else { "" }
    ($in
        | each {|directory|
            [--mount $"type=bind,src=($directory),dst=($directory)($suffix)"]
        }
        | flatten)
}

def readonly-home-mounts []: list<string> -> list<string> {
    ($in
        | each {|directory| $env.HOME | path join $directory }
        | where ($it | path exists)
        | bind-mounts --readonly)
}

def ager-mounts [root: path, manifest: path]: nothing -> list<string> {
    (open ($root | path join $manifest)
        | get entries
        | where ($root | path join $it | path exists)
        | each {|entry|
            [--mount $"type=bind,src=/dev/null,dst=/app/($entry),readonly"]
        }
        | flatten)
}

def config-errors []: record -> list<string> {
    let config = $in
    let unknown = ($config | columns | where $CONFIG_TYPES not-has $it)
    if ($unknown | is-not-empty) {
        return [$"sandbox.json: unsupported keys: ($unknown | str join ', ')"]
    }
    $config
        | items {|key, value|
            let actual = ($value | describe)
            let expected = ($CONFIG_TYPES | get --optional $key)
            let empty_list = ($expected == "list<string>" and $actual == "list<any>" and ($value | is-empty))
            if $actual != $expected and not $empty_list {
                [$"sandbox.json: ($key) must be ($expected), got ($actual)"]
            } else {
                []
            }
        }
        | flatten
}

def configured-mounts [root: path]: record -> list<string> {
    let config = $in
    let home = if $config has readonlyHomeDirectories {
        $config.readonlyHomeDirectories | readonly-home-mounts
    } else {
        []
    }
    let secrets = if $config has agerManifest {
        ager-mounts $root $config.agerManifest
    } else {
        []
    }
    $home | append $secrets
}

def project-config [root: path]: nothing -> record {
    let config = ($root | path join sandbox.json)
    if not ($config | path exists) {
        return {}
    }
    open $config
}

def tty-flags []: nothing -> list<string> {
    if (is-terminal --stdin) and (is-terminal --stdout) { [--tty] } else { [] }
}

def run-sandbox [command: string, args: list<string>]: record -> nothing {
    let project = $in
    let root = $project.root
    let config = $project.config
    let relative = ($env.PWD | path relative-to $root)
    let runtime = (runtime-of $command)
    let image = (runtime-image $root $runtime)
    let caches = (cache-dirs $runtime | create-dirs)
    let uid = (^id --user | str trim)
    let gid = (^id --group | str trim)
    (exec docker run
        --interactive
        ...(tty-flags)
        --rm
        --user $"($uid):($gid)"
        --read-only
        --cap-drop ALL
        --security-opt no-new-privileges
        --tmpfs /tmp:exec
        --tmpfs $env.HOME
        --env $"HOME=($env.HOME)"
        --env TMPDIR=/tmp
        --env REVISION
        --mount $"type=bind,src=($root),dst=/app"
        --workdir $"/app/($relative)"
        ...($caches | bind-mounts)
        ...(runtime-env $runtime)
        ...($config | configured-mounts $root)
        $image
        $command
        ...$args)
}

# Build missing runtime images
def "main build" [
    --force # rebuild images even when they already exist
]: nothing -> nothing {
    let root = (repo-root)
    let runtimes = ($BUILT_RUNTIMES | where (dockerfile-path $root $it | path exists))
    if ($runtimes | is-empty) {
        log error $"sandbox: no Dockerfile found for: ($BUILT_RUNTIMES | str join ', ')"
        exit 1
    }
    for runtime in $runtimes {
        let spec = (image-config $root $runtime | image-spec $root)
        let status = if $force or not (image-exists $spec.image) {
            $spec | build-image
            "built"
        } else {
            "is up to date"
        }
        print $spec.image
        log ok $"sandbox: image ($runtime) ($status)"
    }
}

# Run a command inside its runtime container
def --wrapped main [
    command: string # command to run, such as cargo or pnpm
    ...args: string # arguments forwarded to the command
]: nothing -> nothing {
    match $command {
        "--help" | "-h" => { print (help-text) }
        _ if (is-known $command) => {
            let root = (repo-root)
            let config = (project-config $root)
            let errors = ($config | config-errors)
            if ($errors | is-not-empty) {
                for message in $errors {
                    log error $message
                }
                exit 1
            }
            {root: $root, config: $config} | run-sandbox $command $args
        }
        _ => {
            log error (unknown-command-text $command)
            exit 1
        }
    }
}
