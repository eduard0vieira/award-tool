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
        source: request.source ?? "",
        origin: request.origin,
        destination: request.destination,
        cabinClass: request.cabinClass,
        minK: positiveOrNull(request.minK),
        maxK: positiveOrNull(request.maxK),
        outboundText: request.outboundText ?? "",
        returnText: request.returnText ?? "",
      },
      {
        // The alert is rendered by loading this same server's portal, behind the same Basic Auth.
        baseUrl: `http://localhost:${port}`,
        ...(credentials ? { authUser: credentials.user, authPass: credentials.pass } : {}),
      },
    );
  }
}
