import { applyDecorators } from "@nestjs/common";
import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from "class-validator";

export function AirportField(name: string) {
  return applyDecorators(
    Transform(({ value }) => (typeof value === "string" ? value.toUpperCase() : value)),
    IsString({ message: `O campo ${name} deve ser texto.` }),
    IsNotEmpty({ message: `O campo ${name} é obrigatório.` }),
  );
}

export function OptionalCeilingField(name: string) {
  return applyDecorators(
    IsOptional(),
    IsNumber({}, { message: `O campo ${name} deve ser um número.` }),
    IsPositive({ message: `O campo ${name} deve ser maior que zero.` }),
  );
}

export function OptionalBooleanField(name: string) {
  return applyDecorators(IsOptional(), IsBoolean({ message: `O campo ${name} deve ser verdadeiro ou falso.` }));
}

export function OptionalIntField(name: string, min: number, max: number) {
  const message = `O campo ${name} deve ser um inteiro entre ${min} e ${max}.`;
  return applyDecorators(IsOptional(), IsInt({ message }), Min(min, { message }), Max(max, { message }));
}

export function OptionalNestedField(name: string, type: () => new () => object) {
  return applyDecorators(
    IsOptional(),
    IsObject({ message: `O campo ${name} deve ser um objeto.` }),
    ValidateNested(),
    Type(type),
  );
}

export class SearchGroupDto {
  @IsString({ message: "O campo group.id deve ser texto." })
  @Matches(/^[A-Za-z0-9-]{1,64}$/, { message: "O campo group.id deve ter até 64 letras, números ou hífens." })
  id!: string;

  @IsInt({ message: "O campo group.leg deve ser um inteiro entre 0 e 9." })
  @Min(0, { message: "O campo group.leg deve ser um inteiro entre 0 e 9." })
  @Max(9, { message: "O campo group.leg deve ser um inteiro entre 0 e 9." })
  leg!: number;

  @IsArray({ message: "O campo group.args deve ser uma lista." })
  @ArrayMaxSize(10, { message: "O campo group.args aceita no máximo 10 itens." })
  args!: unknown[];
}

export class RouteRequestDto {
  @AirportField("origin")
  origin!: string;

  @AirportField("destination")
  destination!: string;

  // Asks for a recent identical result instead of a new search. Never part of
  // what makes two searches the same.
  @OptionalBooleanField("reuseRecent")
  reuseRecent?: boolean;

  // Which card on the requester's screen this leg belongs to, so other people
  // can follow the same card live. Not part of what makes two searches the same.
  @OptionalNestedField("group", () => SearchGroupDto)
  group?: SearchGroupDto;
}
