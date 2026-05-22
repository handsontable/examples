<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class Product extends Model
{
    use HasFactory;

    protected $fillable = ['name', 'sku', 'category', 'price', 'stock', 'sort_order'];

    protected $casts = [
        'price'      => 'float',
        'stock'      => 'integer',
        'sort_order' => 'integer',
    ];
}
