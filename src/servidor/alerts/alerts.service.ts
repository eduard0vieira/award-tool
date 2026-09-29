import { Injectable } from "@nestjs/common";
import { gerarAlerta, type AlertaGerado } from "../../saidas/alertas.ts";
import { config } from "../config.ts";
import { CreateAlertDto } from "./create-alert.dto.ts";

function positiveOrNull(value: number | null | undefined): number | null {
  return value != null && value > 0 ? value : null;
}

@Injectable()
export class AlertsService {
  create(request: CreateAlertDto): Promise<AlertaGerado> {
    const { credentials, port } = config;
    return gerarAlerta(
      {
        fonte: request.fonte ?? "",
        origem: request.origem,
        destino: request.destino,
        classe: request.classe,
        menorK: positiveOrNull(request.menorK),
        maiorK: positiveOrNull(request.maiorK),
        textoIda: request.textoIda ?? "",
        textoVolta: request.textoVolta ?? "",
      },
      {
        // The alert is rendered by loading this same server's portal, behind the same Basic Auth.
        baseUrl: `http://localhost:${port}`,
        ...(credentials ? { authUser: credentials.user, authPass: credentials.pass } : {}),
      },
    );
  }
}
