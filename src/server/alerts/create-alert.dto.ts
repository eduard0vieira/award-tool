import { IsNotEmpty, IsNumber, IsOptional, IsString } from "class-validator";

export class CreateAlertDto {
  @IsOptional()
  @IsString({ message: "O campo source deve ser texto." })
  source?: string;

  @IsString({ message: "O campo origin deve ser texto." })
  @IsNotEmpty({ message: "O campo origin é obrigatório." })
  origin!: string;

  @IsString({ message: "O campo destination deve ser texto." })
  @IsNotEmpty({ message: "O campo destination é obrigatório." })
  destination!: string;

  @IsString({ message: "O campo cabinClass deve ser texto." })
  @IsNotEmpty({ message: "O campo cabinClass é obrigatório." })
  cabinClass!: string;

  @IsOptional()
  @IsNumber({}, { message: "O campo minK deve ser um número." })
  minK?: number | null;

  @IsOptional()
  @IsNumber({}, { message: "O campo maxK deve ser um número." })
  maxK?: number | null;

  @IsOptional()
  @IsString({ message: "O campo outboundText deve ser texto." })
  outboundText?: string;

  @IsOptional()
  @IsString({ message: "O campo returnText deve ser texto." })
  returnText?: string;
}
