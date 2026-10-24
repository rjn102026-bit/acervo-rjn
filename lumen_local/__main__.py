import argparse
import json

from .ingest import ingest_capture


def main() -> None:
    parser = argparse.ArgumentParser(description="Ingestão local segura do Lumen")
    subparsers = parser.add_subparsers(dest="command", required=True)
    ingest = subparsers.add_parser("ingest", help="Copiar e verificar mídia de uma captação")
    ingest.add_argument("--source", required=True)
    ingest.add_argument("--destination", required=True)
    ingest.add_argument("--workspace", required=True, help="Identificador do espaço de trabalho")
    ingest.add_argument("--capture", required=True, help="Nome da captação/retranca")
    args = parser.parse_args()

    if args.command == "ingest":
        result = ingest_capture(args.source, args.destination, args.workspace, args.capture)
        print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
