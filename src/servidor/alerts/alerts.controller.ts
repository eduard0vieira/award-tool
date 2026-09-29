import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { AlertsService } from "./alerts.service.ts";
import { CreateAlertDto } from "./create-alert.dto.ts";

@Controller("api/alerta")
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Post()
  @HttpCode(200)
  create(@Body() request: CreateAlertDto) {
    return this.alerts.create(request);
  }
}
