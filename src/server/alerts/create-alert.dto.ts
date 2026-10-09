import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, ValidateNested } from "class-validator";

export class OperatorDto {
  @Matches(/^[A-Z0-9]{2,3}$/, { message: "Cada companhia em operators deve ter um código como AA ou G3." })
  code!: string;

  @IsString({ message: "Cada companhia em operators deve ter um nome." })
  @IsNotEmpty({ message: "Cada companhia em operators deve ter um nome." })
  name!: string;
}

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

  // More than two would make the alert's airline line ambiguous for the client.
  @IsOptional()
  @IsArray({ message: "O campo operators deve ser uma lista de companhias." })
  @ArrayMinSize(1, { message: "O campo operators precisa de pelo menos uma companhia." })
  @ArrayMaxSize(2, {
    message: "As datas desse alerta têm voos de mais de duas companhias. Filtre os voos por companhia para o alerta dizer quem opera.",
  })
  @ValidateNested({ each: true })
  @Type(() => OperatorDto)
  operators?: OperatorDto[];
}
