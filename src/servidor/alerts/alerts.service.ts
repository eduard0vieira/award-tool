import { Injectable } from "@nestjs/common";
import { generateAlert, type GeneratedAlert } from "../../outputs/alerts.ts";
import { config } from "../config.ts";
import { CreateAlertDto } from "./create-alert.dto.ts";

function positiveOrNull(value: number | null | undefined): number | null {
  return value != null && value > 0 ? value : null;
}

@Injectable()
export class AlertsService {
  create(request: CreateAlertDto): Promise<GeneratedAlert> {
    const { credentials, port } = config;
    return generateAlert(
      {
        source: request.fonte ?? "",
        origin: request.origem,
        destination: request.destino,
        cabinClass: request.classe,
        minK: positiveOrNull(request.menorK),
        maxK: positiveOrNull(request.maiorK),
        outboundText: request.textoIda ?? "",
        inboundText: request.textoVolta ?? "",
      },
      {
        // The alert is rendered by loading this same server's portal, behind the same Basic Auth.
        baseUrl: `http://localhost:${port}`,
        ...(credentials ? { authUser: credentials.user, authPass: credentials.pass } : {}),
      },
    );
  }
}
