import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  Matches,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from "class-validator";
import { RouteRequestDto } from "../../search/request-fields.ts";

@ValidatorConstraint({ name: "returnAfterOutbound" })
class ReturnAfterOutbound implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments) {
    return typeof value === "string" && value > (args.object as LatamDatePairDto).outbound;
  }

  defaultMessage(args: ValidationArguments) {
    return `A volta de ${String(args.value)} precisa ser depois da ida de ${(args.object as LatamDatePairDto).outbound}.`;
  }
}

export class LatamDatePairDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "A ida de cada par deve estar no formato AAAA-MM-DD." })
  outbound!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "A volta de cada par deve estar no formato AAAA-MM-DD." })
  @Validate(ReturnAfterOutbound)
  return!: string;
}

// Round-trip dates picked by hand (from Google Flights, say), confirmed in miles
// one by one, in economy or in LATAM's business.
export class LatamPairsSearchDto extends RouteRequestDto {
  @IsIn(["Economy", "Business"], { message: "O campo cabin deve ser Economy ou Business." })
  cabin!: "Economy" | "Business";

  @IsArray({ message: "O campo pairs deve ser uma lista de pares de datas." })
  @ArrayMinSize(1, { message: "Informe pelo menos um par de datas." })
  @ArrayMaxSize(10, { message: "Informe no máximo 10 pares de datas por teste." })
  @ValidateNested({ each: true })
  @Type(() => LatamDatePairDto)
  pairs!: LatamDatePairDto[];
}
