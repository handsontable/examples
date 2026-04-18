<?php

use App\Http\Controllers\ProductController;
use Illuminate\Support\Facades\Route;

Route::get('/products',    [ProductController::class, 'index']);
Route::post('/products',   [ProductController::class, 'store']);
Route::patch('/products',  [ProductController::class, 'batchUpdate']);
Route::delete('/products', [ProductController::class, 'batchDestroy']);
